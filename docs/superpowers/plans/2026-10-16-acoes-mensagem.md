# Message Actions (react, delete, edit, stickers, forward) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents the WhatsApp actions they are missing (react, delete for everyone, edit, stickers, forward) and show in the system when the contact or the office phone deletes or edits a message.

**Architecture:** One shared rules module (`shared/src/message-actions.ts`) decides which action applies to which message. The bubble menu (web) disables exactly what the API (server) refuses. The server gets five new Evolution gateway calls and three new inbound event kinds (office reaction, revoke, edit), parsed from `messages.upsert`, `messages.update` and `messages.delete`. It also gets new `messages` columns and a `message_edits` history table. An office delete or edit writes the database **before** it calls Evolution and rolls back if the call fails, so the webhook echo of our own action finds the work already done and changes nothing. Stickers and forwards reuse the stored file and go through the normal `sendAgentMessage` path (canSee, open chat, BOT_RUNNING). The web adds a bubble action menu, discreet tags, an in-place edit mode, a forward dialog and a recent-stickers panel.

**Tech Stack:** Node 24, TypeScript 5.9.3 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite 0.5.10 in tests), zod 4.6.7, vitest 5.0.4, React 19.3.1, @tanstack/react-query 5.104.2, Tailwind 4.3.3, @phosphor-icons/react 2.1.10. Evolution API v2.3.7 (Baileys 7.0.0-rc.9). **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-10-16-acoes-mensagem-design.md`. The Evolution behavior this plan relies on was checked in the 2.3.7 source (`whatsapp.baileys.service.ts`, below BS) and in Baileys rc9 `Utils/process-message.js`:
- A contact or office-phone **revoke** reaches Baileys as `messages.update {message: null}` and Evolution sends `MESSAGES_DELETE` with `data = { ...key, status: 'DELETED' }` (BS:1655-1656). Our own `deleteMessageForEveryone` sends `MESSAGES_DELETE` with `data = { id: <Evolution row cuid>, key: { id, remoteJid, fromMe }, ... }` (BS:3804).
- An **edit** reaches Evolution as `messages.update {message: {editedMessage: {message: <new content>}}}`, and Evolution forwards it as `MESSAGES_UPDATE` with `data = { keyId: <target id>, remoteJid, fromMe, status, message }` (process-message.js MESSAGE_EDIT; BS:1613-1625, 1702).
- **Neither payload has `@lid` rewritten to the phone.** Only `messages.upsert` gets that rewrite (BS:1478). Evolution also skips both payloads when the original message is not in its own database (BS:1648-1651).
- **Protocol messages never reach `messages.upsert`:** BS:1165 does a `continue` on them.
- **The new edit format** (`secretEncryptedMessage`, `secretEncType` 2 = MESSAGE_EDIT, `targetMessageKey`) **does** arrive as a normal `messages.upsert`, with an encrypted body.
- **`MESSAGES_EDITED` is awaited inside the instance queue** (BS:1133). While our app is down, every protocol message stalls the instance for about 20 minutes. Never subscribe to it.
- `/chat/updateMessage` compares the stored `key.remoteJid` with `createJid(number)`. `deleteMessageForEveryone` and the reaction key use `remoteJid` as given. `createJid` drops the ninth digit of a Brazilian mobile when the DDD is 31 or above and the subscriber number starts at 7 or above (`src/utils/createJid.ts`).

## Global Constraints

- No new dependency in any workspace. Use the stdlib: `node:crypto` `createHash`, `Intl.Segmenter`, `RegExp`.
- Evolution 2.3.7 endpoints, exactly:
  - `POST /message/sendReaction/{i}` `{ key: { remoteJid, fromMe, id }, reaction }`. A `''` reaction removes it.
  - `DELETE /chat/deleteMessageForEveryone/{i}` `{ id, remoteJid, fromMe }`.
  - `POST /chat/updateMessage/{i}` `{ number, key: { remoteJid, fromMe: true, id }, text }`.
  - `POST /message/sendSticker/{i}` as **JSON** `{ number, sticker: <raw base64>, quoted? }`. Never multipart.
  - `POST /webhook/set/{i}` `{ webhook: { enabled, url, byEvents, base64, events } }`.
  - There is no forward endpoint.
- The webhook events are exactly `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `MESSAGES_DELETE`, `CONNECTION_UPDATE` and `QRCODE_UPDATED`. **Never `MESSAGES_EDITED`.** Existing instances get this list at boot through `POST /webhook/set/{instance}`. The call is idempotent and runs once per boot.
- Inbound edits and revokes match the target only by `(channel_id, external_id)`, never by `remoteJid`.
- Time windows count from `messages.sent_at`: edit 15 min (`EDIT_WINDOW_MS`), delete for everyone 48 h (`DELETE_WINDOW_MS`).
- Size limits:
  - recent stickers: 40 (`RECENT_STICKERS_LIMIT`);
  - sticker upload: PNG, JPEG or WebP up to 1 MB (`STICKER_MAX_BYTES`);
  - edited text: 1–4096 characters after trim.
- Every user action follows these rules:
  - it goes through `getChatForUser`, which answers 404 when the user cannot see the chat;
  - the chat must be `open`, or the action gets 409 `'Conversa finalizada'`;
  - it never applies to a note.
- The Origin check is global (`authPlugin`). Every new mutation is a non-GET `/api/*` route, and its tests send `loginAs(...).headers`.
- Office delete and edit change the database first and roll back if Evolution fails. Nothing calls Evolution inside a DB transaction. Inside `ctx.db.transaction(tx => …)` use only `tx`, because PGlite deadlocks otherwise. Publish to the hub after commit.
- An Evolution error becomes HTTP 502 with a pt-BR message. Logs carry the message id and `err.name` only, never message text, bodies or the Evolution response.
- UI copy is pt-BR, exactly as the spec gives it:
  - menu items: "Reagir", "Responder", "Encaminhar", "Copiar", "Editar", "Apagar para todos";
  - disabled-item hints: "Só até 15 min após o envio" and "Só até 48 h após o envio";
  - delete confirmation: title "Apagar para todos?", body "O contato deixa de ver esta mensagem.";
  - bubble tags: "Apagada pelo contato", "Apagada por <nome>", "Apagada pelo celular", "editada", "editada pelo contato", "editada pelo contato (novo texto indisponível)", "Encaminhada";
  - sticker panel button: "Enviar imagem como figurinha";
  - forward error (400): "Esta mídia não está disponível para encaminhar".
- Code identifiers are English.
- Extend, never rename.
  - The new `MessageDto` fields are **optional**, so existing literals keep compiling. `toMessageDto` always fills them.
  - `fromMe` on the `reaction` inbound event is optional, and `parse.ts` always fills it.
- The migration is generated, never hand-edited: `npm run db:generate -w server -- --name acoes_mensagem` creates `0003_acoes_mensagem`.
- Reuse what the web already has:
  - `confirmDialog` (`web/src/lib/confirm.ts`) for the delete confirmation;
  - `Modal` and `BotRunningDialog` (`ChatDialogs.tsx`) for dialogs;
  - the theme tokens (`bg-panel`, `bg-surface`, `bg-bubble-in`, `text-fg`, `text-muted`, `text-danger`, `border-border`, `border-field`). No raw colors.
- Commit after every task with a Conventional Commit message. Every commit command ends with `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

## Review Focus

These are inputs and conditions the spec implies but never tests, most likely first. The owning task adds the named test.

1. **The webhook echo of the office's own action.** An office delete comes back as `MESSAGES_DELETE fromMe`. An edit comes back as `MESSAGES_UPDATE fromMe` with the same text. A reaction comes back as a `messages.upsert` reaction with `fromMe`. None of these may relabel the change as "pelo celular", add a second history row or a second timeline event. The office paths save first, and ingest ignores deletes of rows that are already deleted and edits whose text equals the current body. **Owner: Task 4**, test `ignores the echoes of the office actions (Review Focus 1)`. **Task 6** also has `the webhook echo of our own edit adds no second version (Review Focus 1)`.
2. **A Brazilian mobile stored with 13 digits** (`5565999999999`) while WhatsApp's JID has 12 (`556599999999@s.whatsapp.net`). `deleteMessageForEveryone` and the reaction/edit keys take the JID as-is, so they need Evolution's `createJid` rule, or the delete goes to a chat that does not exist. **Owner: Task 3**, test `jidOf drops the 9th digit like Evolution createJid (Review Focus 2)`.
3. **Evolution fails in the middle of a delete or an edit** (timeout, 400 "Message not found", instance closed). The row must go back to how it was: no `deleted_*`, the old body, no history row, no event. The agent gets the pt-BR 502, and the log has no message text. **Owner: Task 5** `rolls back when Evolution fails (Review Focus 3)` and **Task 6** `rolls back the text and the history when Evolution fails (Review Focus 3)`.
4. **A double click, or two agents deleting the same message.** Evolution is called once and the second request gets 409 `'Mensagem apagada'`. The claim is `UPDATE … WHERE deleted_at IS NULL`. **Owner: Task 5**, test `a second delete is 409 and calls Evolution once (Review Focus 4)`.
5. **Reusing a file from a chat the user cannot see.** A sticker id or a forward source from a hidden chat gets 404. The recent-stickers list only scans visible chats, so a sector barrier never leaks through the sticker panel. **Owners: Task 7** `refuses a sticker from a chat the user cannot see (Review Focus 5)` and **Task 8** `needs canSee on both ends (Review Focus 5)`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Shared**
- `shared/src/message-actions.ts` (T1, create): `MessageChangeSource`, windows and limits, `ActionTarget`/`ActionBlock`, and `reactBlock`, `replyBlock`, `editBlock`, `deleteBlock`, `forwardBlock`, `isSingleEmoji`.
- `shared/src/index.ts` (T1): re-exports the above; new optional `MessageDto` fields; `MessageEditDto`, `RecentStickerDto`; `ChatEventKind` gains `message_deleted` and `message_edited`.

**Server**
- `server/src/db/schema.ts` (T2): adds `messages.officeReaction`, `deletedAt`, `deletedBy`, `deletedSource`, `editedAt`, `forwardedFromId` and `mediaSha256`, plus the `message_edits` table.
- `server/drizzle/0003_acoes_mensagem.sql`, `server/drizzle/meta/0003_snapshot.json`, `server/drizzle/meta/_journal.json` (T2): the generated migration.
- `server/src/messages/dto.ts` (T2): `toMessageDto` fills `officeReaction`, `deleted`, `edited` and `forwarded`.
- `server/src/whatsapp/types.ts` (T3): `MessageKeyRef` and the five new gateway methods. (T4) adds the `revoke` and `edit` inbound events and `reaction.fromMe`.
- `server/src/whatsapp/evolution.ts` (T3): `jidOf`, `DELETE` support in `call`, the five new methods, `MESSAGES_DELETE` in `WEBHOOK_EVENTS`.
- `server/src/whatsapp/fake.ts` (T3): records the new calls.
- `server/src/channels/service.ts` (T3): `syncWebhooks`, and a private `webhookUrl` helper that `createChannel` also uses.
- `server/src/index.ts` (T3): calls `syncWebhooks` at boot.
- `server/src/whatsapp/parse.ts` (T4): parses `messages.delete`, edits in `messages.update`, `secretEncryptedMessage` edits and office reactions.
- `server/test/fixtures/evolution/delete-in.json`, `delete-api.json`, `edit-update-in.json`, `secret-edit-in.json` (T4, create).
- `server/src/messages/ingest.ts` (T4): `applyReaction` gets the office slot; new `applyRevoke` and `applyEdit`. (T7) stores `mediaSha256` on downloads.
- `server/src/messages/send.ts`:
  - (T5) exports `gatewayTarget`; a deleted message cannot be quoted;
  - (T7) adds stickers: `SendInput.asSticker`, `SendInput.stickerFromMessageId`, `reusableMessage`, the sticker gateway branch and `mediaSha256` on uploads;
  - (T8) adds `SendInput.forwardFromId` and `forwarded_from_id`.
- `server/src/messages/actions.ts` (create): (T5) `reactToMessage`, `deleteMessageForEveryone`; (T6) `editMessage`, `listMessageEdits`; (T7) `listRecentStickers`; (T8) `forwardMessage`.
- `server/src/messages/media.ts` (T7): `saveMedia` also returns `sha256`.
- `server/src/inbox/chats.ts` (T8): `startChat` takes an optional `channelId`.
- `server/src/chats/routes.ts`: new routes. (T5) reaction and DELETE; (T6) PATCH and edits; (T7) sticker JSON body, multipart `asSticker`, `GET /api/stickers/recent`; (T8) forward.

**Server tests**
- `server/test/messages/action-rules.test.ts` (T1, create).
- `server/test/db/schema.test.ts`, `server/test/messages/dto.test.ts`, `server/test/realtime/hub.test.ts` (T2).
- `server/test/whatsapp/evolution.test.ts`, `server/test/whatsapp/fake.test.ts`, `server/test/channels/service.test.ts` (T3).
- `server/test/whatsapp/parse.test.ts`, `server/test/messages/ingest.test.ts` (T4).
- `server/test/messages/actions-seed.ts` (T5, create; T7 adds `multipart`).
- `server/test/messages/actions.test.ts` (T5 create, T6).
- `server/test/messages/stickers.test.ts` (T7, create), `server/test/messages/media.test.ts` (T7).
- `server/test/messages/forward.test.ts` (T8, create).

**Web**
- `web/src/components/conversation/model.ts` (+ `model.test.ts`) (T1): `eventText` for the new kinds, plus `deletedTag` and `editedTag`.
- `web/src/lib/api.ts` (+ `api.test.ts`) (T9): `api.messages.react/remove/edit/edits/forward`, `api.chats.sendSticker`, `api.stickers.recent`, `SendFileInput.asSticker`, `qk.messageEdits`, `qk.recentStickers`.
- `web/src/components/conversation/MessageDialogs.tsx` (create): (T9) `EditHistoryDialog`; (T10) `ForwardDialog`. Tests in `MessageDialogs.test.tsx` (T10).
- `web/src/components/conversation/MessageBubble.tsx` (+ `MessageBubble.test.tsx`): (T9) tags, both reactions, history dialog; (T11) menu, edit mode, delete.
- `web/src/components/conversation/StickerPanel.tsx` (T10, create) and `Composer.tsx` (+ `Composer.test.tsx`) (T10): the "Figurinhas" button.
- `web/src/components/conversation/MessageMenu.tsx` (T11, create): `menuItems` and `MessageMenu`.
- `web/src/components/conversation/Timeline.tsx` and `ConversationView.tsx` (T11): pass `chatOpen` down.

**Docs**
- `docs/superpowers/plans/2026-10-16-acoes-mensagem-aceite.md` (T12, create) and `docs/IMPLANTACAO.md` (T12).

---

## Shared contract

Every name below is defined in exactly one task and used with this spelling everywhere.

**`shared/src/message-actions.ts` (Task 1)**
```ts
export type MessageChangeSource = 'office' | 'contact' | 'phone';
export const EDIT_WINDOW_MS: number;          // 15 * 60 * 1000
export const DELETE_WINDOW_MS: number;        // 48 * 60 * 60 * 1000
export const QUICK_REACTIONS: readonly ['👍', '❤️', '😂', '😮', '😢', '🙏'];
export const RECENT_STICKERS_LIMIT: number;   // 40
export const STICKER_MAX_BYTES: number;       // 1024 * 1024
export const DELETED_REASON: string;          // 'Mensagem apagada'
export interface ActionTarget { direction: 'in' | 'out'; kind: string; body: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; authorId: string | null; sentAt: string | Date; deleted?: unknown }
export interface ActionBlock { reason: string; expired: boolean }
export function reactBlock(m: ActionTarget): ActionBlock | null;
export function replyBlock(m: ActionTarget): ActionBlock | null;
export function editBlock(m: ActionTarget, userId: string | null, now: number): ActionBlock | null;
export function deleteBlock(m: ActionTarget, now: number): ActionBlock | null;
export function forwardBlock(m: ActionTarget): ActionBlock | null;
export function isSingleEmoji(s: string): boolean;
```
Both a `MessageDto` and a messages row with `{ ...row, deleted: row.deletedAt }` fit `ActionTarget`.

**`shared/src/index.ts` (Task 1)**
```ts
// MessageDto gains (optional):
officeReaction?: string | null;
deleted?: { at: string; source: MessageChangeSource; byName: string | null } | null;
edited?: { at: string; source: MessageChangeSource; newTextUnavailable: boolean } | null;
forwarded?: boolean;
export interface MessageEditDto { id: string; previousBody: string | null; source: MessageChangeSource; editedByName: string | null; newTextUnavailable: boolean; editedAt: string }
export interface RecentStickerDto { messageId: string; url: string }
// ChatEventKind gains: 'message_deleted' | 'message_edited'   (data: { messageId: string; source: MessageChangeSource })
```

**`server/src/db/schema.ts` (Task 2)**: new `messages` columns `officeReaction`, `deletedAt`, `deletedBy`, `deletedSource`, `editedAt`, `forwardedFromId` and `mediaSha256`, and the table `messageEdits`. Its columns are `id`, `messageId` (cascade), `previousBody`, `source`, `editedBy` (set null), `newTextUnavailable` (default false) and `editedAt` (default now()).

**`server/src/whatsapp/types.ts` (Tasks 3 and 4)**
```ts
export interface MessageKeyRef { address: string; externalId: string; fromMe: boolean }   // address as in waAddress
// WhatsAppGateway gains:
sendReaction(instance: string, key: MessageKeyRef, emoji: string): Promise<void>;
deleteForEveryone(instance: string, key: MessageKeyRef): Promise<void>;
editText(instance: string, key: MessageKeyRef, text: string): Promise<void>;
sendSticker(instance: string, phone: string, base64: string, quoted?: QuotedRef): Promise<SendResult>;
setWebhook(instance: string, webhookUrl: string): Promise<void>;
// InboundEvent gains (Task 4):
| { type: 'reaction'; ...; fromMe?: boolean }
| { type: 'revoke'; instance: string; targetExternalId: string; fromMe: boolean }
| { type: 'edit'; instance: string; targetExternalId: string; fromMe: boolean; text: string | null }
```
`server/src/whatsapp/evolution.ts` also exports `jidOf(address: string): string` (Task 3).
`server/src/channels/service.ts` exports `syncWebhooks(ctx: AppCtx): Promise<void>` (Task 3).

**`server/src/messages/send.ts`**
```ts
export async function gatewayTarget(db: Db, chatId: string): Promise<{ instance: string; address: string }>;      // Task 5
export const MEDIA_NOT_FORWARDABLE = 'Esta mídia não está disponível para encaminhar';                             // Task 7
export async function reusableMessage(ctx: AppCtx, user: AuthUser, messageId: string): Promise<{ msg: MessageRow; chat: ChatRow }>; // Task 7
// SendInput gains: asSticker?: boolean; stickerFromMessageId?: string (Task 7); forwardFromId?: string (Task 8)
```

**`server/src/messages/actions.ts`**
```ts
export async function reactToMessage(ctx: AppCtx, user: AuthUser, messageId: string, emoji: string): Promise<MessageDto>;      // Task 5
export async function deleteMessageForEveryone(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto>;            // Task 5
export async function editMessage(ctx: AppCtx, user: AuthUser, messageId: string, text: string): Promise<MessageDto>;           // Task 6
export async function listMessageEdits(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageEditDto[]>;              // Task 6
export async function listRecentStickers(ctx: AppCtx, user: AuthUser): Promise<RecentStickerDto[]>;                            // Task 7
export type ForwardTarget = { chatId: string; botAction?: BotAction } | { contactId: string; channelId?: string; botAction?: BotAction }; // Task 8
export async function forwardMessage(ctx: AppCtx, user: AuthUser, messageId: string, to: ForwardTarget): Promise<MessageDto>;   // Task 8
```

**HTTP (`server/src/chats/routes.ts`)**
| Route | Body | Answer | Task |
|---|---|---|---|
| `POST /api/messages/:id/reaction` | `{ emoji: string }` (`''` removes) | `MessageDto` | 5 |
| `DELETE /api/messages/:id` | none | `MessageDto` | 5 |
| `PATCH /api/messages/:id` | `{ text }` | `MessageDto` | 6 |
| `GET /api/messages/:id/edits` | none | `MessageEditDto[]` (newest first) | 6 |
| `POST /api/chats/:id/messages` | JSON `{ stickerFromMessageId, replyToId?, botAction? }`, or multipart with `asSticker=true` | `MessageDto` | 7 |
| `GET /api/stickers/recent` | none | `RecentStickerDto[]` | 7 |
| `POST /api/messages/:id/forward` | `{ chatId, botAction? }` or `{ contactId, channelId?, botAction? }` | the new `MessageDto` | 8 |

**Web**
- `web/src/components/conversation/model.ts` (Task 1): `deletedTag(d: NonNullable<MessageDto['deleted']>): string` and `editedTag(e: NonNullable<MessageDto['edited']>): string`.
- `web/src/lib/api.ts` (Task 9):
  - inputs: `SendStickerInput { stickerFromMessageId; replyToId?; botAction? }`, `ForwardInput = ({ chatId } | { contactId; channelId? }) & { botAction? }`, `SendFileInput.asSticker?`;
  - message calls: `api.messages.react(id, emoji)`, `.remove(id)`, `.edit(id, text)`, `.edits(id)`, `.forward(id, input)`;
  - send and sticker calls: `api.chats.sendSticker(chatId, input)`, `api.stickers.recent()`;
  - query keys: `qk.messageEdits(id)`, `qk.recentStickers`.
- Components:
  - `web/src/components/conversation/MessageDialogs.tsx`: `EditHistoryDialog({ messageId, onClose })` (Task 9) and `ForwardDialog({ message, onClose })` (Task 10).
  - `web/src/components/conversation/StickerPanel.tsx` (Task 10): `StickerPanel({ onPick(messageId), onPickFile(file), onClose })`.
  - `web/src/components/conversation/MessageMenu.tsx` (Task 11): `menuItems(m, meId, chatOpen, now): MenuItem[]` and `MessageMenu(props)`.
  - `MessageBubble` gains the prop `chatOpen?: boolean`, and so does `Timeline` (Task 11).

---
### Task 1: Shared rules, DTO fields and pt-BR texts

The rules are pure functions, so the server and the web can share them. The new `ChatEventKind` values force new cases in `eventText`, because its `switch` is exhaustive. That is why the web text helpers belong to this task: without them `npm run typecheck` would fail.

**Files:**
- Create: `shared/src/message-actions.ts`
- Modify: `shared/src/index.ts` (imports at lines 4-11, `MessageDto` at lines 25-27, `ChatEventKind` at lines 29-31, new DTOs after `TimelineItem` at line 32)
- Modify: `web/src/components/conversation/model.ts` (import at line 1, `eventText` at lines 68-105, new exports after it)
- Test: `server/test/messages/action-rules.test.ts` (create)
- Test: `web/src/components/conversation/model.test.ts` (import at line 4, new `describe` at the end)

**Interfaces:**
- Consumes: nothing new.
- Produces: everything listed under `shared/src/message-actions.ts` and `shared/src/index.ts` in the Shared contract, plus `deletedTag` and `editedTag` in `web/src/components/conversation/model.ts`.

- [ ] **Step 1: Write the failing rules test**

Create `server/test/messages/action-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DELETE_WINDOW_MS, EDIT_WINDOW_MS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, reactBlock, replyBlock,
  type ActionTarget,
} from '@talk/shared';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const out = (over: Partial<ActionTarget> = {}): ActionTarget => ({
  direction: 'out', kind: 'text', body: 'Olá', status: 'sent', authorId: 'u1', sentAt: ago(60_000), deleted: null, ...over,
});

describe('message action rules', () => {
  it('lets the author edit a text, or a caption, for 15 minutes', () => {
    expect(editBlock(out(), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ kind: 'image', body: 'legenda' }), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ kind: 'video', body: 'legenda' }), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ sentAt: ago(EDIT_WINDOW_MS) }), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ sentAt: ago(EDIT_WINDOW_MS + 1) }), 'u1', NOW)).toEqual({
      reason: 'Só até 15 min após o envio', expired: true,
    });
  });

  it('never edits someone else, a bot, the phone, a failed send or a non-text message', () => {
    const notYours = { reason: 'Só dá para editar mensagens enviadas por você', expired: false };
    expect(editBlock(out(), 'u2', NOW)).toEqual(notYours);
    expect(editBlock(out({ authorId: null }), null, NOW)).toEqual(notYours); // bot, triage and office phone have no author
    expect(editBlock(out({ direction: 'in', authorId: null }), 'u1', NOW)).toEqual(notYours);
    expect(editBlock(out({ status: 'failed' }), 'u1', NOW)).toEqual(notYours);
    const notText = { reason: 'Só dá para editar texto ou legenda', expired: false };
    expect(editBlock(out({ kind: 'document', body: 'Segue' }), 'u1', NOW)).toEqual(notText);
    expect(editBlock(out({ kind: 'image', body: null }), 'u1', NOW)).toEqual(notText);
    expect(editBlock(out({ kind: 'audio', body: null }), 'u1', NOW)).toEqual(notText);
  });

  it('deletes for everyone only office messages with a WhatsApp id, for 48 hours', () => {
    expect(deleteBlock(out({ authorId: null }), NOW)).toBeNull(); // bot, triage and phone sends are the office too
    expect(deleteBlock(out({ sentAt: ago(DELETE_WINDOW_MS) }), NOW)).toBeNull();
    expect(deleteBlock(out({ sentAt: ago(DELETE_WINDOW_MS + 1) }), NOW)).toEqual({
      reason: 'Só até 48 h após o envio', expired: true,
    });
    const notOffice = { reason: 'Só dá para apagar mensagens enviadas pelo escritório', expired: false };
    expect(deleteBlock(out({ direction: 'in' }), NOW)).toEqual(notOffice);
    expect(deleteBlock(out({ kind: 'note' }), NOW)).toEqual(notOffice);
    expect(deleteBlock(out({ status: 'pending' }), NOW)).toEqual(notOffice);
  });

  it('reacts to and quotes any message that has a WhatsApp id', () => {
    expect(reactBlock(out({ direction: 'in' }))).toBeNull();
    expect(reactBlock(out())).toBeNull();
    expect(reactBlock(out({ status: 'pending' }))).toEqual({ reason: 'Esta mensagem não aceita reação', expired: false });
    expect(reactBlock(out({ kind: 'note' }))?.expired).toBe(false);
    expect(replyBlock(out({ direction: 'in' }))).toBeNull();
    expect(replyBlock(out({ status: 'failed' }))).toEqual({ reason: 'Esta mensagem não pode ser citada', expired: false });
  });

  it('forwards anything with content except notes and unsupported messages', () => {
    expect(forwardBlock(out({ direction: 'in', kind: 'image' }))).toBeNull();
    expect(forwardBlock(out({ status: 'failed' }))).toBeNull(); // the content is ours; the WhatsApp id does not matter
    expect(forwardBlock(out({ kind: 'note' }))).toEqual({ reason: 'Esta mensagem não pode ser encaminhada', expired: false });
    expect(forwardBlock(out({ kind: 'unsupported' }))?.expired).toBe(false);
  });

  it('refuses every action on a deleted message, whatever else is true', () => {
    const deleted = out({ deleted: new Date() });
    const gone = { reason: 'Mensagem apagada', expired: false };
    expect(reactBlock(deleted)).toEqual(gone);
    expect(replyBlock(deleted)).toEqual(gone);
    expect(forwardBlock(deleted)).toEqual(gone);
    expect(editBlock(deleted, 'u1', NOW)).toEqual(gone);
    expect(deleteBlock(deleted, NOW)).toEqual(gone);
  });

  it('accepts exactly one emoji', () => {
    for (const e of ['👍', '❤️', '😂', '🙏', '👍🏽', '👨‍👩‍👧', '🇧🇷']) expect(isSingleEmoji(e)).toBe(true);
    for (const e of ['', 'a', '👍👍', 'ok👍', '1', ' ']) expect(isSingleEmoji(e)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/messages/action-rules.test.ts`
Expected: FAIL. The import of `deleteBlock` (and the others) from `@talk/shared` does not exist yet: `does not provide an export named 'DELETE_WINDOW_MS'`.

- [ ] **Step 3: Create the rules module**

Create `shared/src/message-actions.ts`:

```ts
// Rules of the message actions (spec 2026-10-16 §3–§7), shared so the bubble menu (web) offers exactly what the
// API (server) accepts. Runtime code with no imports: tsx (server) and Vite (web) load this source directly.

/** Who reacted, deleted or edited: an agent in the system, the contact, or the office's own phone. */
export type MessageChangeSource = 'office' | 'contact' | 'phone';

/** WhatsApp lets the sender edit for about 15 min and delete for everyone for about 2 days (spec §4, §5). */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
export const RECENT_STICKERS_LIMIT = 40;
export const STICKER_MAX_BYTES = 1024 * 1024;
export const DELETED_REASON = 'Mensagem apagada';

/** The fields the rules read. A MessageDto fits, and so does a messages row passed as `{ ...row, deleted: row.deletedAt }`. */
export interface ActionTarget {
  direction: 'in' | 'out';
  kind: string;
  body: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  authorId: string | null;
  sentAt: string | Date;
  /** Truthy = deleted for everyone. */
  deleted?: unknown;
}

/**
 * Why an action is refused. `expired`: the action applies to this message but its time is over, so the menu shows
 * it disabled with `reason` as the hint. Otherwise the menu leaves it out. The API answers 409 with `reason` either way.
 */
export interface ActionBlock { reason: string; expired: boolean }

const block = (reason: string, expired = false): ActionBlock => ({ reason, expired });
const age = (m: ActionTarget, now: number) => now - new Date(m.sentAt).getTime();
/** Notes and pending/failed sends have no WhatsApp id to point a reaction, quote, edit or delete at. */
const noWhatsAppId = (m: ActionTarget) => m.kind === 'note' || m.status === 'pending' || m.status === 'failed';

export function reactBlock(m: ActionTarget): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (noWhatsAppId(m)) return block('Esta mensagem não aceita reação');
  return null;
}

export function replyBlock(m: ActionTarget): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (noWhatsAppId(m)) return block('Esta mensagem não pode ser citada');
  return null;
}

/** Spec §5: only text, or the caption of an image/video, sent by this very agent (never bot, triage or phone), for 15 min. */
export function editBlock(m: ActionTarget, userId: string | null, now: number): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (m.direction !== 'out' || m.authorId === null || m.authorId !== userId || noWhatsAppId(m)) {
    return block('Só dá para editar mensagens enviadas por você');
  }
  const editable = m.kind === 'text' || ((m.kind === 'image' || m.kind === 'video') && !!m.body);
  if (!editable) return block('Só dá para editar texto ou legenda');
  if (age(m, now) > EDIT_WINDOW_MS) return block('Só até 15 min após o envio', true);
  return null;
}

/** Spec §4: any office message (agent, bot, triage, phone) with a WhatsApp id, for 48 h; any agent who sees the chat. */
export function deleteBlock(m: ActionTarget, now: number): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (m.direction !== 'out' || noWhatsAppId(m)) return block('Só dá para apagar mensagens enviadas pelo escritório');
  if (age(m, now) > DELETE_WINDOW_MS) return block('Só até 48 h após o envio', true);
  return null;
}

/** Spec §7: notes and deleted messages are never forwarded; an unsupported message has nothing to send. */
export function forwardBlock(m: ActionTarget): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (m.kind === 'note' || m.kind === 'unsupported') return block('Esta mensagem não pode ser encaminhada');
  return null;
}

/** Spec §3 "um emoji só": one grapheme that is a pictograph or a flag (skin tones and ZWJ families count as one). */
export function isSingleEmoji(s: string): boolean {
  const graphemes = [...new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(s)];
  // ponytail: keycaps (1️⃣) and other non-pictographic emoji are refused; widen the class if someone misses one
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
}
```

- [ ] **Step 4: Export the rules and add the DTO fields**

In `shared/src/index.ts`, replace

```ts
import type { BotRunningBehavior, NotificationDto } from './bots.js';
```

with

```ts
import type { BotRunningBehavior, NotificationDto } from './bots.js';
import type { MessageChangeSource } from './message-actions.js';
```

and replace

```ts
export type * from './bots.js';
```

with

```ts
export type * from './bots.js';
export {
  EDIT_WINDOW_MS, DELETE_WINDOW_MS, QUICK_REACTIONS, RECENT_STICKERS_LIMIT, STICKER_MAX_BYTES, DELETED_REASON,
  reactBlock, replyBlock, editBlock, deleteBlock, forwardBlock, isSingleEmoji,
} from './message-actions.js';
export type * from './message-actions.js';
```

Replace the last line of `MessageDto`

```ts
  botRunId?: string | null; botName?: string | null }
```

with

```ts
  botRunId?: string | null; botName?: string | null;
  // message actions (spec 2026-10-16), optional for the same reason; toMessageDto always fills them (Task 2)
  officeReaction?: string | null;
  deleted?: { at: string; source: MessageChangeSource; byName: string | null } | null;
  edited?: { at: string; source: MessageChangeSource; newTextUnavailable: boolean } | null;
  forwarded?: boolean }
```

Replace

```ts
  | 'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note';
```

with

```ts
  | 'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note'
  | 'message_deleted' | 'message_edited'; // data: { messageId, source: MessageChangeSource }
```

and after

```ts
export type TimelineItem = ({ type: 'message' } & MessageDto) | ({ type: 'event' } & ChatEventDto);
```

add

```ts
/** GET /api/messages/:id/edits: the text before each edit, newest first. */
export interface MessageEditDto { id: string; previousBody: string | null; source: MessageChangeSource; editedByName: string | null; newTextUnavailable: boolean; editedAt: string }
/** GET /api/stickers/recent (spec §6). */
export interface RecentStickerDto { messageId: string; url: string }
```

- [ ] **Step 5: Run the rules test to verify it passes**

Run: `npm test -w server -- test/messages/action-rules.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the failing web text test**

In `web/src/components/conversation/model.test.ts`, replace

```ts
import { buildTimelineRows, dayLabel, errorMessage, eventText, isConflict, mergeTimelinePages, previewText } from './model';
```

with

```ts
import {
  buildTimelineRows, dayLabel, deletedTag, editedTag, errorMessage, eventText, isConflict, mergeTimelinePages, previewText,
} from './model';
```

and append at the end of the file:

```ts
describe('message action texts', () => {
  const names = new Map<string, string>();
  const when = '2026-10-16T12:00:00.000Z';

  it('describes deletes and edits by who made them', () => {
    const del = (data: Record<string, unknown>, authorName: string | null = null) =>
      eventText(event({ kind: 'message_deleted', data, authorName }), names);
    expect(del({ messageId: 'm1', source: 'office' }, 'Bia')).toBe('Mensagem apagada por Bia');
    expect(del({ messageId: 'm1', source: 'contact' })).toBe('Mensagem apagada pelo contato');
    expect(del({ messageId: 'm1', source: 'phone' })).toBe('Mensagem apagada pelo celular');
    expect(eventText(event({ kind: 'message_edited', authorName: 'Bia', data: { messageId: 'm1', source: 'office' } }), names)).toBe(
      'Mensagem editada por Bia',
    );
    expect(eventText(event({ kind: 'message_edited', data: { messageId: 'm1', source: 'contact' } }), names)).toBe(
      'Mensagem editada pelo contato',
    );
  });

  it('labels the bubble tags exactly as the spec', () => {
    expect(deletedTag({ at: when, source: 'contact', byName: null })).toBe('Apagada pelo contato');
    expect(deletedTag({ at: when, source: 'office', byName: 'Ana Lima' })).toBe('Apagada por Ana Lima');
    expect(deletedTag({ at: when, source: 'phone', byName: null })).toBe('Apagada pelo celular');
    expect(editedTag({ at: when, source: 'office', newTextUnavailable: false })).toBe('editada');
    expect(editedTag({ at: when, source: 'contact', newTextUnavailable: false })).toBe('editada pelo contato');
    expect(editedTag({ at: when, source: 'contact', newTextUnavailable: true })).toBe('editada pelo contato (novo texto indisponível)');
    expect(editedTag({ at: when, source: 'phone', newTextUnavailable: false })).toBe('editada pelo celular');
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL. `deletedTag` / `editedTag` are not exported, and `eventText` returns `undefined` for `message_deleted`.

- [ ] **Step 8: Add the texts**

In `web/src/components/conversation/model.ts`, replace

```ts
import type { ChatEventDto, TimelineItem } from '@talk/shared';
```

with

```ts
import type { ChatEventDto, MessageDto, TimelineItem } from '@talk/shared';
```

In `eventText`, replace

```ts
    case 'bot_note':
      return `Nota do chatbot ${bot}: ${String(e.data.text ?? '')}`;
  }
}
```

with

```ts
    case 'bot_note':
      return `Nota do chatbot ${bot}: ${String(e.data.text ?? '')}`;
    case 'message_deleted':
      return `Mensagem apagada${changedBy(e)}`;
    case 'message_edited':
      return `Mensagem editada${changedBy(e)}`;
  }
}

/** Spec §2: changes made on WhatsApp read "pelo contato" / "pelo celular"; the office reads "por <nome>". */
function changedBy(e: ChatEventDto): string {
  if (e.data.source === 'contact') return ' pelo contato';
  if (e.data.source === 'phone') return ' pelo celular';
  return e.authorName ? ` por ${e.authorName}` : '';
}

/** Bubble tag of a message deleted for everyone (spec §4). The text stays visible to the team. */
export function deletedTag(d: NonNullable<MessageDto['deleted']>): string {
  if (d.source === 'contact') return 'Apagada pelo contato';
  if (d.source === 'phone') return 'Apagada pelo celular';
  return `Apagada por ${d.byName ?? 'atendente'}`;
}

/** Bubble tag of an edited message (spec §5). Clicking it shows the previous versions. */
export function editedTag(e: NonNullable<MessageDto['edited']>): string {
  const who = e.source === 'contact' ? ' pelo contato' : e.source === 'phone' ? ' pelo celular' : '';
  return `editada${who}${e.newTextUnavailable ? ' (novo texto indisponível)' : ''}`;
}
```

- [ ] **Step 9: Run the tests and the typecheck**

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0 for shared, server and web.

- [ ] **Step 10: Commit**

```bash
git add shared/src/message-actions.ts shared/src/index.ts server/test/messages/action-rules.test.ts web/src/components/conversation/model.ts web/src/components/conversation/model.test.ts
git commit -m "feat(shared): message action rules, DTO fields and pt-BR texts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database columns, `message_edits` and the DTO

**Files:**
- Modify: `server/src/db/schema.ts`:
  - the type import at line 17;
  - the `messages` columns after `botRunId` at line 196;
  - the new table appended at the end of the file.
- Create (generated, never hand-edited): `server/drizzle/0003_acoes_mensagem.sql`, `server/drizzle/meta/0003_snapshot.json`. Modify (generated): `server/drizzle/meta/_journal.json`.
- Modify: `server/src/messages/dto.ts`
- Test: `server/test/db/schema.test.ts` (import at line 6, count at line 33, new `describe` at the end)
- Test: `server/test/messages/dto.test.ts` (import at line 3, exact literal at line 41, new `it`)
- Test: `server/test/realtime/hub.test.ts` (exact literal at line 160)

**Interfaces:**
- Consumes (Task 1): `MessageChangeSource` and the optional `MessageDto` fields.
- Produces:
  - `messages` columns: `officeReaction text`, `deletedAt timestamptz`, `deletedBy uuid → users (set null)`, `deletedSource text<MessageChangeSource>`, `editedAt timestamptz`, `forwardedFromId uuid → messages (set null)`, `mediaSha256 text`;
  - table `messageEdits` (`message_edits`);
  - `toMessageDto` always fills `officeReaction`, `deleted`, `edited` (from the latest `message_edits` row) and `forwarded`.

- [ ] **Step 1: Write the failing schema tests**

In `server/test/db/schema.test.ts`, replace

```ts
import { botRuns, botVersions, bots, chats, contacts, messages, sectors } from '../../src/db/schema.js';
```

with

```ts
import { botRuns, botVersions, bots, chats, contacts, messageEdits, messages, sectors } from '../../src/db/schema.js';
```

change

```ts
    expect(tables).toHaveLength(20);
```

to

```ts
    expect(tables).toHaveLength(21);
```

and append at the end of the file:

```ts
describe('message action columns', () => {
  let db: Db;
  let s: Seeded;

  beforeEach(async () => {
    db = await makeTestDb();
    s = await seedBasics({ db });
  });

  async function seedMessage() {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const [chat] = await db
      .insert(chats)
      .values({ contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    const [m] = await db
      .insert(messages)
      .values({ chatId: chat.id, channelId: s.channelId, direction: 'out', kind: 'text', body: 'oi', sentAt: new Date() })
      .returning();
    return m;
  }

  it('defaults a message to no office reaction, not deleted, not edited, not forwarded', async () => {
    expect(await seedMessage()).toMatchObject({
      officeReaction: null, deletedAt: null, deletedBy: null, deletedSource: null, editedAt: null, forwardedFromId: null,
      mediaSha256: null,
    });
  });

  it('drops the edit history with its message and only unlinks a forwarded copy', async () => {
    const original = await seedMessage();
    const [copy] = await db
      .insert(messages)
      .values({
        chatId: original.chatId, channelId: s.channelId, direction: 'out', kind: 'text', body: 'oi', sentAt: new Date(),
        forwardedFromId: original.id,
      })
      .returning();
    const [edit] = await db.insert(messageEdits).values({ messageId: original.id, previousBody: 'antes', source: 'contact' }).returning();
    expect(edit).toMatchObject({ editedBy: null, newTextUnavailable: false });
    expect(edit.editedAt).toBeInstanceOf(Date);

    await db.delete(messages).where(eq(messages.id, original.id));

    expect(await db.select().from(messageEdits)).toEqual([]);
    const [after] = await db.select().from(messages).where(eq(messages.id, copy.id));
    expect(after.forwardedFromId).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: FAIL. `messageEdits` is not exported by `schema.ts`.

- [ ] **Step 3: Add the columns and the table**

In `server/src/db/schema.ts`, replace

```ts
import type { BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind } from '@talk/shared';
```

with

```ts
import type { BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, MessageChangeSource } from '@talk/shared';
```

In `messages`, replace

```ts
    botRunId: uuid('bot_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }), // set = sent by a chatbot
```

with

```ts
    botRunId: uuid('bot_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }), // set = sent by a chatbot
    // Message actions (spec 2026-10-16 §8). `reaction` is the contact's; this is the office's (agent or office phone).
    officeReaction: text('office_reaction'),
    // Deleted for everyone: the text stays for the team, the bubble shows who deleted it.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }), // office deletes only
    deletedSource: text('deleted_source').$type<MessageChangeSource>(),
    editedAt: timestamp('edited_at', { withTimezone: true }), // previous texts live in message_edits
    forwardedFromId: uuid('forwarded_from_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    mediaSha256: text('media_sha256'), // hex digest of the stored file; dedupes the recent stickers (spec §6)
```

Append at the end of the file:

```ts
/** Spec §5: one row per edit, holding the text the message had before it. */
export const messageEdits = pgTable(
  'message_edits',
  {
    id: id(),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    previousBody: text('previous_body'),
    source: text('source').$type<MessageChangeSource>().notNull(),
    editedBy: uuid('edited_by').references(() => users.id, { onDelete: 'set null' }), // null unless source = 'office'
    // WhatsApp's encrypted edit format: the message was edited but the new text never reached us.
    newTextUnavailable: boolean('new_text_unavailable').notNull().default(false),
    // DB now() (microseconds), not a JS Date: two edits in the same millisecond still sort.
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('message_edits_message_idx').on(t.messageId, t.editedAt)],
);
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate -w server -- --name acoes_mensagem`
Expected: drizzle-kit prints `Your SQL migration file ➜ drizzle\0003_acoes_mensagem.sql` and asks no questions (nothing is renamed).

Check the SQL (bash, repo root):

```bash
grep -c -e 'CREATE TABLE "message_edits"' -e '"office_reaction" text' -e '"deleted_at" timestamp with time zone' -e '"deleted_by" uuid' -e '"deleted_source" text' -e '"edited_at" timestamp with time zone' -e '"forwarded_from_id" uuid' -e '"media_sha256" text' -e 'message_edits_message_idx' server/drizzle/0003_acoes_mensagem.sql
```
Expected: `10`. `"edited_at" timestamp with time zone` matches twice, once in `message_edits` and once in `messages`. Also check that `server/drizzle/meta/_journal.json` has an entry with `"idx": 3` and `"tag": "0003_acoes_mensagem"`.

- [ ] **Step 5: Run the schema tests to verify they pass**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing DTO test and update the exact literals**

In `server/test/messages/dto.test.ts`, replace

```ts
import { chats, contacts, messages } from '../../src/db/schema.js';
```

with

```ts
import { chats, contacts, messageEdits, messages } from '../../src/db/schema.js';
```

and replace the line (in the first test's `toEqual`)

```ts
      authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
```

with

```ts
      authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
      officeReaction: null, deleted: null, edited: null, forwarded: false,
```

Add this test inside `describe('toMessageDto', …)`, after the first `it`:

```ts
  it('fills the office reaction, the delete, the latest edit and the forward mark', async () => {
    const { ctx, s, chatId } = await setup();
    const sourceId = randomUUID();
    await ctx.db.insert(messages).values({
      id: sourceId, chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'original',
      externalId: 'ext-src', status: 'sent', sentAt: new Date('2026-10-16T11:00:00Z'),
    });
    const [row] = await ctx.db.insert(messages).values({
      id: randomUUID(), chatId, channelId: s.channelId, direction: 'out', kind: 'text', body: 'novo texto',
      authorId: s.agentA.id, externalId: 'ext-3', status: 'read', officeReaction: '❤️', forwardedFromId: sourceId,
      deletedAt: new Date('2026-10-16T12:10:00Z'), deletedBy: s.agentA.id, deletedSource: 'office',
      editedAt: new Date('2026-10-16T12:05:00Z'), sentAt: new Date('2026-10-16T12:00:00Z'),
    }).returning();
    await ctx.db.insert(messageEdits).values([
      { messageId: row.id, previousBody: 'texto', source: 'office', editedBy: s.agentA.id, editedAt: new Date('2026-10-16T12:01:00Z') },
      { messageId: row.id, previousBody: 'novo', source: 'phone', newTextUnavailable: true, editedAt: new Date('2026-10-16T12:05:00Z') },
    ]);

    expect(await toMessageDto(ctx.db, row)).toMatchObject({
      officeReaction: '❤️',
      deleted: { at: '2026-10-16T12:10:00.000Z', source: 'office', byName: s.agentA.name },
      edited: { at: '2026-10-16T12:05:00.000Z', source: 'phone', newTextUnavailable: true }, // the latest edit wins
      forwarded: true,
    });

    const [plain] = await ctx.db.select().from(messages).where(eq(messages.id, sourceId));
    expect(await toMessageDto(ctx.db, plain!)).toMatchObject({ officeReaction: null, deleted: null, edited: null, forwarded: false });
  });
```

Add `import { eq } from 'drizzle-orm';` to the imports of `dto.test.ts`.

In `server/test/realtime/hub.test.ts`, replace the line

```ts
      media: null, mediaUnavailable: false, authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
```

with

```ts
      media: null, mediaUnavailable: false, authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
      officeReaction: null, deleted: null, edited: null, forwarded: false,
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npm test -w server -- test/messages/dto.test.ts test/realtime/hub.test.ts`
Expected: FAIL. The `toEqual` literals miss `officeReaction`, `deleted`, `edited` and `forwarded`, and the new test gets `undefined`.

- [ ] **Step 8: Fill the DTO**

In `server/src/messages/dto.ts`, replace

```ts
import { eq } from 'drizzle-orm';
import type { MessageDto } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { botRuns, bots, messages, users } from '../db/schema.js';
```

with

```ts
import { desc, eq } from 'drizzle-orm';
import type { MessageDto } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { botRuns, bots, messageEdits, messages, users } from '../db/schema.js';
```

and replace

```ts
  const [bot] = row.botRunId
    ? await db.select({ name: bots.name }).from(botRuns).innerJoin(bots, eq(bots.id, botRuns.botId)).where(eq(botRuns.id, row.botRunId))
    : [];
```

with

```ts
  const [bot] = row.botRunId
    ? await db.select({ name: bots.name }).from(botRuns).innerJoin(bots, eq(bots.id, botRuns.botId)).where(eq(botRuns.id, row.botRunId))
    : [];
  // Only deleted/edited rows pay for these lookups.
  const [deleter] = row.deletedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.deletedBy)) : [];
  const [lastEdit] = row.editedAt
    ? await db
        .select({ source: messageEdits.source, newTextUnavailable: messageEdits.newTextUnavailable })
        .from(messageEdits)
        .where(eq(messageEdits.messageId, row.id))
        .orderBy(desc(messageEdits.editedAt))
        .limit(1)
    : [];
```

and replace

```ts
    botRunId: row.botRunId,
    botName: bot?.name ?? null,
  };
```

with

```ts
    botRunId: row.botRunId,
    botName: bot?.name ?? null,
    officeReaction: row.officeReaction,
    deleted: row.deletedAt
      ? { at: row.deletedAt.toISOString(), source: row.deletedSource ?? 'office', byName: deleter?.name ?? null }
      : null,
    edited: row.editedAt
      ? {
          at: row.editedAt.toISOString(),
          source: lastEdit?.source ?? 'office',
          newTextUnavailable: lastEdit?.newTextUnavailable ?? false,
        }
      : null,
    forwarded: row.forwardedFromId !== null,
  };
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -w server -- test/db/schema.test.ts test/messages/dto.test.ts test/realtime/hub.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add server/src/db/schema.ts server/drizzle/0003_acoes_mensagem.sql server/drizzle/meta/0003_snapshot.json server/drizzle/meta/_journal.json server/src/messages/dto.ts server/test/db/schema.test.ts server/test/messages/dto.test.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): message action columns, message_edits and DTO fields" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Evolution gateway calls and the boot-time webhook update

**Files:**
- Modify: `server/src/whatsapp/types.ts` (new interface after `DownloadedMedia` at line 6; new methods at the end of `WhatsAppGateway`, lines 8-18)
- Modify: `server/src/whatsapp/evolution.ts` (header comment at lines 1-40, `WEBHOOK_EVENTS` at line 43, `call` at line 51, new methods)
- Modify: `server/src/whatsapp/fake.ts`
- Modify: `server/src/channels/service.ts` (`createChannel` at lines 46-61; new `syncWebhooks` at the end)
- Modify: `server/src/index.ts` (import at line 7, call after `syncChannelStatuses` at line 42)
- Test: `server/test/whatsapp/evolution.test.ts`, `server/test/whatsapp/fake.test.ts`, `server/test/channels/service.test.ts`

**Interfaces:**
- Consumes: `QuotedRef`, `SendResult` (existing, `types.ts`).
- Produces:
  - `MessageKeyRef` and the five gateway methods (Shared contract);
  - `jidOf(address: string): string`, exported from `evolution.ts`;
  - `syncWebhooks(ctx: AppCtx): Promise<void>`;
  - the fake records `{ method: 'sendReaction' | 'deleteForEveryone' | 'editText', instance, phone: key.address, payload }`, `{ method: 'sendSticker', instance, phone, payload: { base64, quoted } }` and `{ method: 'setWebhook', instance, payload: { webhookUrl } }`.

- [ ] **Step 1: Write the failing gateway tests**

In `server/test/whatsapp/evolution.test.ts`, replace

```ts
import { createEvolutionGateway } from '../../src/whatsapp/evolution.js';
```

with

```ts
import { createEvolutionGateway, jidOf } from '../../src/whatsapp/evolution.js';
```

In the `createInstance` test, replace

```ts
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
```

with

```ts
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
```

Append at the end of the file:

```ts
const EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

describe('createEvolutionGateway: message actions', () => {
  const key = { address: PHONE, externalId: '3EB0ABCDEF', fromMe: true };
  const JID = '556599999999@s.whatsapp.net';

  it('sendReaction posts the key with the JID Evolution would build; an empty reaction removes it', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.sendReaction('talk-abc', { ...key, fromMe: false }, '👍');
    await wa.sendReaction('talk-abc', key, '');
    expect(req(0)).toEqual({
      url: 'http://evolution:8080/message/sendReaction/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { key: { remoteJid: JID, fromMe: false, id: '3EB0ABCDEF' }, reaction: '👍' },
    });
    expect(req(1).body).toEqual({ key: { remoteJid: JID, fromMe: true, id: '3EB0ABCDEF' }, reaction: '' });
  });

  it('deleteForEveryone sends DELETE with id, remoteJid and fromMe', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await expect(wa.deleteForEveryone('talk-abc', key)).resolves.toBeUndefined();
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/deleteMessageForEveryone/talk-abc',
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: { id: '3EB0ABCDEF', remoteJid: JID, fromMe: true },
    });
  });

  it('editText posts our number, the key and the new text', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.editText('talk-abc', key, 'Novo texto');
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/updateMessage/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { number: PHONE, key: { remoteJid: JID, fromMe: true, id: '3EB0ABCDEF' }, text: 'Novo texto' },
    });
  });

  it('sendSticker posts raw base64 as JSON (never multipart) and returns the key id', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    const quoted = { externalId: 'Q1', body: 'oi', fromMe: false };
    await expect(wa.sendSticker('talk-abc', PHONE, 'UklGRg==', quoted)).resolves.toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendSticker/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: {
        number: PHONE,
        sticker: 'UklGRg==',
        quoted: { key: { id: 'Q1', fromMe: false, remoteJid: `${PHONE}@s.whatsapp.net` }, message: { conversation: 'oi' } },
      },
    });
  });

  it('setWebhook replaces the webhook with the same events as createInstance, never MESSAGES_EDITED', async () => {
    const { wa, req } = setup(201, { webhook: {} });
    await wa.setWebhook('talk-abc', 'http://app:3000/webhooks/evolution/s3cr3t');
    expect(req()).toEqual({
      url: 'http://evolution:8080/webhook/set/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { webhook: { enabled: true, url: 'http://app:3000/webhooks/evolution/s3cr3t', byEvents: false, base64: false, events: EVENTS } },
    });
    expect(EVENTS).not.toContain('MESSAGES_EDITED');
  });

  it('uses a LID address as-is', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.deleteForEveryone('talk-abc', { ...key, address: '201234567890123@lid' });
    expect(req().body).toEqual({ id: '3EB0ABCDEF', remoteJid: '201234567890123@lid', fromMe: true });
  });

  it('throws on a non-2xx answer, like every call', async () => {
    const { wa } = setup(400, { message: 'Message not found' });
    await expect(wa.editText('talk-abc', key, 'x')).rejects.toThrow(/Evolution POST \/chat\/updateMessage\/talk-abc failed: 400/);
  });
});

describe('jidOf', () => {
  it('drops the 9th digit like Evolution createJid (Review Focus 2)', () => {
    expect(jidOf('5565999999999')).toBe('556599999999@s.whatsapp.net');
    expect(jidOf('5531987654321')).toBe('553187654321@s.whatsapp.net');
    expect(jidOf('5511987654321')).toBe('5511987654321@s.whatsapp.net'); // DDD below 31 keeps it
    expect(jidOf('5565961234567')).toBe('5565961234567@s.whatsapp.net'); // subscriber starting below 7 keeps it
    expect(jidOf('556532221111')).toBe('556532221111@s.whatsapp.net'); // 12 digits: untouched
    expect(jidOf('201234567890123@lid')).toBe('201234567890123@lid');
  });
});
```

In `server/test/whatsapp/fake.test.ts`, add this test inside `describe('createFakeGateway', …)`:

```ts
  it('records the message actions; stickers get ids like every send; failNext applies to them', async () => {
    const wa = createFakeGateway();
    const key = { address: '5565999999999', externalId: 'WA-1', fromMe: true };
    await wa.sendReaction('talk-test', key, '👍');
    await wa.deleteForEveryone('talk-test', key);
    await wa.editText('talk-test', key, 'novo');
    expect(await wa.sendSticker('talk-test', '5565999999999', 'UklGRg==')).toEqual({ externalId: 'fake-1' });
    await wa.setWebhook('talk-test', 'http://app:3000/webhooks/evolution/s');

    expect(wa.sent).toEqual([
      { method: 'sendReaction', instance: 'talk-test', phone: '5565999999999', payload: { key, emoji: '👍' } },
      { method: 'deleteForEveryone', instance: 'talk-test', phone: '5565999999999', payload: { key } },
      { method: 'editText', instance: 'talk-test', phone: '5565999999999', payload: { key, text: 'novo' } },
      { method: 'sendSticker', instance: 'talk-test', phone: '5565999999999', payload: { base64: 'UklGRg==' } },
      { method: 'setWebhook', instance: 'talk-test', payload: { webhookUrl: 'http://app:3000/webhooks/evolution/s' } },
    ]);

    wa.failNext();
    await expect(wa.deleteForEveryone('talk-test', key)).rejects.toThrow('fake gateway failure');
  });
```

In `server/test/channels/service.test.ts`, replace

```ts
  syncChannelStatuses,
} from '../../src/channels/service.js';
```

with

```ts
  syncChannelStatuses,
  syncWebhooks,
} from '../../src/channels/service.js';
```

and append at the end of the file:

```ts
describe('syncWebhooks', () => {
  it('pushes the webhook URL to every instance; one failure does not stop the others', async () => {
    await ctx.db.insert(channels).values({ name: 'Outro', evolutionInstance: 'talk-outro', status: 'disconnected' });
    const calls: string[] = [];
    let first = true;
    ctx.wa.setWebhook = async (instance, url) => {
      calls.push(`${instance} ${url}`);
      if (first) {
        first = false;
        throw new Error('evolution down');
      }
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await syncWebhooks(ctx);

    const url = 'http://app:3000/webhooks/evolution/test-webhook-secret-0123456789abcdef';
    expect(calls.sort()).toEqual([`talk-outro ${url}`, `talk-test ${url}`]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('webhook sync failed', { instance: expect.any(String), err: 'Error' });
    logged.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/whatsapp/evolution.test.ts test/whatsapp/fake.test.ts test/channels/service.test.ts`
Expected: FAIL. `jidOf` and `syncWebhooks` are not exported, `wa.sendReaction is not a function`, and the `createInstance` events miss `MESSAGES_DELETE`.

- [ ] **Step 3: Extend the gateway interface**

In `server/src/whatsapp/types.ts`, after

```ts
export interface DownloadedMedia { base64: string; mime: string; fileName?: string }
```

add

```ts
/** A message in a 1:1 chat. `address` as in waAddress: canonical phone digits or '<lid>@lid'. */
export interface MessageKeyRef { address: string; externalId: string; fromMe: boolean }
```

and replace

```ts
  fetchProfilePicture(instance: string, address: string): Promise<string | null>;
}
```

with

```ts
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
}
```

- [ ] **Step 4: Implement the Evolution calls**

In `server/src/whatsapp/evolution.ts`, replace the header line

```ts
// - Routes: POST /message/sendText|sendMedia|sendWhatsAppAudio/:i (201)
```

with

```ts
// - Routes: POST /message/sendText|sendMedia|sendWhatsAppAudio|sendSticker|sendReaction/:i (201)
//   sendSticker: JSON { number, sticker: raw base64 } (multipart is buggy in 2.3.7); PNG/JPEG converted to WebP by sharp.
//   sendReaction: { key: { remoteJid, fromMe, id }, reaction } with '' removing it (sendMessage.controller.ts isEmoji).
// - Routes: DELETE /chat/deleteMessageForEveryone/:i { id, remoteJid, fromMe }; POST /chat/updateMessage/:i
//   { number, key, text } (rejects when the stored key.remoteJid differs from createJid(number) or the original is not
//   in Evolution's DB); POST /webhook/set/:i { webhook: { enabled, url, byEvents, base64, events } } (webhook.router.ts)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/chat.router.ts
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/event/webhook/webhook.schema.ts
```

Replace

```ts
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];
```

with

```ts
// MESSAGES_DELETE carries revokes (contact, office phone, our own deleteMessageForEveryone). Never MESSAGES_EDITED:
// Evolution 2.3.7 awaits that delivery inside the instance's event queue (whatsapp.baileys.service.ts:1133), so while
// the app is down every later event of the instance waits ~20 min per protocol message. Edits still arrive as
// MESSAGES_UPDATE with message.editedMessage.
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];
const webhookConfig = (url: string) => ({ enabled: true, url, byEvents: false, base64: false, events: WEBHOOK_EVENTS });

/**
 * The chat JID Evolution's createJid (src/utils/createJid.ts, formatBRNumber) builds from a number: a Brazilian
 * 13-digit mobile loses its 9th digit when the DDD is 31 or more and the subscriber number starts at 7 or more.
 * Needed where Evolution takes the JID as-is (deleteMessageForEveryone, reaction and edit keys); a '<lid>@lid' or any
 * full JID passes through.
 */
export function jidOf(address: string): string {
  if (address.includes('@')) return address;
  const m = /^55(\d{2})\d(\d{8})$/.exec(address);
  const digits = m && Number(m[1]) >= 31 && Number(m[2]![0]) >= 7 ? `55${m[1]}${m[2]}` : address;
  return `${digits}@s.whatsapp.net`;
}
```

Replace

```ts
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
```

with

```ts
  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
```

In `createInstance`, replace

```ts
        webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: WEBHOOK_EVENTS },
```

with

```ts
        webhook: webhookConfig(webhookUrl),
```

and replace the end of the returned object

```ts
      return res?.profilePictureUrl || null;
    },
  };
}
```

with

```ts
      return res?.profilePictureUrl || null;
    },

    async sendReaction(instance, key, emoji) {
      await call('POST', `/message/sendReaction/${seg(instance)}`, {
        key: { remoteJid: jidOf(key.address), fromMe: key.fromMe, id: key.externalId },
        reaction: emoji,
      });
    },

    async deleteForEveryone(instance, key) {
      await call('DELETE', `/chat/deleteMessageForEveryone/${seg(instance)}`, {
        id: key.externalId,
        remoteJid: jidOf(key.address),
        fromMe: key.fromMe,
      });
    },

    async editText(instance, key, text) {
      // `number` goes through Evolution's own createJid; the key's remoteJid must already be that JID.
      await call('POST', `/chat/updateMessage/${seg(instance)}`, {
        number: key.address,
        key: { remoteJid: jidOf(key.address), fromMe: key.fromMe, id: key.externalId },
        text,
      });
    },

    sendSticker(instance, phone, base64, quoted) {
      return send(`/message/sendSticker/${seg(instance)}`, { number: phone, sticker: base64, quoted: quotedPayload(phone, quoted) });
    },

    async setWebhook(instance, webhookUrl) {
      await call('POST', `/webhook/set/${seg(instance)}`, { webhook: webhookConfig(webhookUrl) });
    },
  };
}
```

- [ ] **Step 5: Teach the fake the new calls**

In `server/src/whatsapp/fake.ts`, replace

```ts
    // No guard(): this runs in the background after inbound messages and must not eat an error armed by failNext.
```

with

```ts
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
```

- [ ] **Step 6: Add `syncWebhooks` and call it at boot**

In `server/src/channels/service.ts`, replace

```ts
export async function createChannel(ctx: AppCtx, name: string): Promise<ChannelDto> {
```

with

```ts
/** Where Evolution posts this app's events (the secret is part of the path). */
function webhookUrl(ctx: AppCtx): string {
  return `${ctx.config.webhookBaseUrl}/webhooks/evolution/${ctx.config.webhookSecret}`;
}

export async function createChannel(ctx: AppCtx, name: string): Promise<ChannelDto> {
```

and in `createChannel`, replace

```ts
    await ctx.wa.createInstance(instance, `${ctx.config.webhookBaseUrl}/webhooks/evolution/${ctx.config.webhookSecret}`);
```

with

```ts
    await ctx.wa.createInstance(instance, webhookUrl(ctx));
```

Append at the end of the file:

```ts
/**
 * Boot (spec §5): instances only got their webhook events at creation, so push today's list (it adds MESSAGES_DELETE)
 * to every existing one. Idempotent: Evolution upserts the instance's webhook row. Each channel has its own try/catch,
 * so one unreachable instance does not stop the rest; the next boot tries again. Logs the instance and the error name.
 */
export async function syncWebhooks(ctx: AppCtx): Promise<void> {
  const rows = await ctx.db.select({ instance: channels.evolutionInstance }).from(channels);
  for (const { instance } of rows) {
    try {
      await ctx.wa.setWebhook(instance, webhookUrl(ctx));
    } catch (err) {
      console.error('webhook sync failed', { instance, err: err instanceof Error ? err.name : typeof err });
    }
  }
}
```

In `server/src/index.ts`, replace

```ts
import { syncChannelStatuses } from './channels/service.js';
```

with

```ts
import { syncChannelStatuses, syncWebhooks } from './channels/service.js';
```

and after

```ts
syncChannelStatuses(ctx).catch((err: unknown) => app.log.error({ err }, 'falha ao sincronizar status dos canais'));
```

add

```ts
// Once per boot: existing instances get today's webhook events (MESSAGES_DELETE since "ações de mensagem"). Never throws
// per channel; only a failing DB read reaches this catch.
syncWebhooks(ctx).catch((err: unknown) => app.log.error({ err }, 'falha ao atualizar os webhooks dos canais'));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/whatsapp/evolution.test.ts test/whatsapp/fake.test.ts test/channels/service.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/whatsapp/types.ts server/src/whatsapp/evolution.ts server/src/whatsapp/fake.ts server/src/channels/service.ts server/src/index.ts server/test/whatsapp/evolution.test.ts server/test/whatsapp/fake.test.ts server/test/channels/service.test.ts
git commit -m "feat(server): Evolution reaction, delete, edit, sticker and webhook calls" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Inbound office reactions, revokes and edits

**Files:**
- Modify: `server/src/whatsapp/types.ts` (the `InboundEvent` union, lines 20-30)
- Modify: `server/src/whatsapp/parse.ts` (switch at lines 45-56, `parseUpsert` at lines 83-91, `parseUpdate` at lines 136-147, new helpers)
- Create: `server/test/fixtures/evolution/delete-in.json`, `delete-api.json`, `edit-update-in.json`, `secret-edit-in.json`
- Modify: `server/src/messages/ingest.ts` (imports at lines 2 and 8, dispatch at line 62, `applyReaction` at lines 82-90, new `applyRevoke` / `applyEdit`)
- Test: `server/test/whatsapp/parse.test.ts` (reaction cases at lines 68-69, the "own reaction" test at lines 136-140, new `describe`)
- Test: `server/test/messages/ingest.test.ts` (imports, new `describe`)

**Interfaces:**
- Consumes (Task 2): `messages.officeReaction`, `deletedAt`, `deletedSource`, `editedAt`, table `messageEdits`. Consumes (existing): `addEvent(db, chatId, kind, data, authorId)` from `server/src/inbox/events.ts`; `eventsOf(ctx, chatId)` from `server/test/inbox/fixtures.ts`.
- Produces:
  - inbound events `{ type: 'revoke'; instance; targetExternalId; fromMe }` and `{ type: 'edit'; instance; targetExternalId; fromMe; text: string | null }`;
  - `reaction.fromMe?: boolean`, which `parse.ts` always fills;
  - ingest results: `fromMe` reactions go to `office_reaction`. Revokes set `deleted_at` and `deleted_source = fromMe ? 'phone' : 'contact'` plus a `message_deleted` event. Edits add a `message_edits` row, set `edited_at`, replace the body when the text is known, and add a `message_edited` event. Every applied change publishes `message.updated` and `chat.updated`.

- [ ] **Step 1: Add the fixtures**

Create `server/test/fixtures/evolution/delete-in.json`. This is what Evolution sends when the contact deletes for everyone (BS:1656, `{ ...key, status }`):

```json
{
  "event": "messages.delete",
  "instance": "talk-test",
  "data": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-TEXT-IN", "status": "DELETED" },
  "date_time": "2025-10-14T11:10:00.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

Create `server/test/fixtures/evolution/delete-api.json`. This is the echo of our own `deleteMessageForEveryone` (BS:3804): `id` is Evolution's row id and `key` is the WhatsApp key:

```json
{
  "event": "messages.delete",
  "instance": "talk-test",
  "data": {
    "id": "cmgq0000000000000000000001",
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": true, "id": "MSG-OUT-0001" },
    "messageType": "conversation",
    "status": "DELETED",
    "source": "web",
    "messageTimestamp": 1760440000,
    "pushName": "Escritório",
    "participant": null,
    "message": { "conversation": "Olá" }
  },
  "date_time": "2025-10-14T11:10:00.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

Create `server/test/fixtures/evolution/edit-update-in.json`. This is a contact edit as `MESSAGES_UPDATE` (BS:1613-1625). The `remoteJid` is still the LID, because Evolution only rewrites it in upserts:

```json
{
  "event": "messages.update",
  "instance": "talk-test",
  "data": {
    "keyId": "MSG-TEXT-IN",
    "remoteJid": "201234567890123@lid",
    "fromMe": false,
    "participant": null,
    "status": "SERVER_ACK",
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "messageId": "cmgq0000000000000000000002",
    "message": { "editedMessage": { "message": { "conversation": "Olá, preciso de ajuda urgente" } } }
  },
  "date_time": "2025-10-14T11:08:00.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

Create `server/test/fixtures/evolution/secret-edit-in.json`. This is the new encrypted edit format, which arrives as a normal upsert (`secretEncType` 2 = MESSAGE_EDIT in WAProto):

```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-SECRET-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "secretEncryptedMessage": {
        "targetMessageKey": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-TEXT-IN" },
        "encPayload": "q83vEjRWeJA=",
        "encIv": "AAECAwQFBgcICQoL",
        "secretEncType": 2
      },
      "messageContextInfo": { "deviceListMetadataVersion": 2 }
    },
    "messageType": "secretEncryptedMessage",
    "messageTimestamp": 1760440100,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:08:20.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

- [ ] **Step 2: Write the failing parse tests**

In `server/test/whatsapp/parse.test.ts`, replace

```ts
    ['reaction', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: '👍' }],
    ['reaction-removed', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: null }],
```

with

```ts
    ['reaction', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: '👍', fromMe: false }],
    ['reaction-removed', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: null, fromMe: false }],
```

and replace

```ts
  it('ignores a reaction the office sent from the phone', () => {
    const body = fixture('reaction');
    body.data.key.fromMe = true;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'ignored', reason: 'own reaction' }]);
  });
```

with

```ts
  it('keeps a reaction the office sent from the phone, flagged fromMe (the office slot, spec §3)', () => {
    const body = fixture('reaction');
    body.data.key.fromMe = true;
    expect(parseEvolutionWebhook(body)).toEqual([
      { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: '👍', fromMe: true },
    ]);
  });
```

Append at the end of the file:

```ts
describe('parseEvolutionWebhook — deletes and edits', () => {
  it('reads a revoke by the contact from messages.delete', () => {
    expect(parseEvolutionWebhook(fixture('delete-in'))).toEqual([
      { type: 'revoke', instance: INSTANCE, targetExternalId: 'MSG-TEXT-IN', fromMe: false },
    ]);
  });

  it('reads the WhatsApp key, not the Evolution row id, from the echo of our own delete', () => {
    expect(parseEvolutionWebhook(fixture('delete-api'))).toEqual([
      { type: 'revoke', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', fromMe: true },
    ]);
  });

  it('reads an edit from messages.update, @lid remoteJid included', () => {
    expect(parseEvolutionWebhook(fixture('edit-update-in'))).toEqual([
      { type: 'edit', instance: INSTANCE, targetExternalId: 'MSG-TEXT-IN', fromMe: false, text: 'Olá, preciso de ajuda urgente' },
    ]);
  });

  it('reads an edited caption, an extended text and an edit made on the office phone', () => {
    const body = fixture('edit-update-in');
    body.data.fromMe = true;
    body.data.message = { editedMessage: { message: { imageMessage: { caption: 'Nova legenda', mimetype: 'image/jpeg' } } } };
    expect(parseEvolutionWebhook(body)).toEqual([
      { type: 'edit', instance: INSTANCE, targetExternalId: 'MSG-TEXT-IN', fromMe: true, text: 'Nova legenda' },
    ]);
    body.data.message = { editedMessage: { message: { protocolMessage: { editedMessage: { extendedTextMessage: { text: 'Texto longo' } } } } } };
    expect(parseEvolutionWebhook(body)).toMatchObject([{ type: 'edit', text: 'Texto longo' }]);
  });

  it('turns the encrypted edit format into an edit with unknown text, never an unsupported message', () => {
    expect(parseEvolutionWebhook(fixture('secret-edit-in'))).toEqual([
      { type: 'edit', instance: INSTANCE, targetExternalId: 'MSG-TEXT-IN', fromMe: false, text: null },
    ]);
  });

  it('ignores other encrypted messages, edits without text and deletes without id', () => {
    const secret = fixture('secret-edit-in');
    secret.data.message.secretEncryptedMessage.secretEncType = 1; // EVENT_EDIT
    expect(parseEvolutionWebhook(secret)).toEqual([{ type: 'ignored', reason: 'secret message' }]);
    const edit = fixture('edit-update-in');
    edit.data.message = { editedMessage: { message: { audioMessage: {} } } };
    expect(parseEvolutionWebhook(edit)).toEqual([{ type: 'ignored', reason: 'edit without text' }]);
    const del = fixture('delete-in');
    delete del.data.id;
    expect(parseEvolutionWebhook(del)).toEqual([{ type: 'ignored', reason: 'missing id' }]);
  });

  it('still reads plain statuses from messages.update', () => {
    expect(parseEvolutionWebhook(fixture('status-delivered'))).toEqual([
      { type: 'status', instance: INSTANCE, externalId: 'MSG-OUT-0001', status: 'delivered' },
    ]);
    expect(parseEvolutionWebhook(fixture('status-inbound'))).toEqual([{ type: 'ignored', reason: 'status of inbound message' }]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test -w server -- test/whatsapp/parse.test.ts`
Expected: FAIL. The reactions have no `fromMe`, `messages.delete` gives `ignored: event messages.delete`, and the edit update gives `ignored: status of inbound message`.

- [ ] **Step 4: Add the event types**

In `server/src/whatsapp/types.ts`, replace

```ts
  | { type: 'reaction'; instance: string; targetExternalId: string; emoji: string | null }
```

with

```ts
  // fromMe: the office reacted (from its phone, or the echo of our own sendReaction). parse.ts always fills it.
  | { type: 'reaction'; instance: string; targetExternalId: string; emoji: string | null; fromMe?: boolean }
  // Deleted for everyone: by the contact, or (fromMe) by the office phone or our own deleteMessageForEveryone.
  | { type: 'revoke'; instance: string; targetExternalId: string; fromMe: boolean }
  // An edit; text null = WhatsApp's encrypted edit format, the new text is unknown.
  | { type: 'edit'; instance: string; targetExternalId: string; fromMe: boolean; text: string | null }
```

- [ ] **Step 5: Parse them**

In `server/src/whatsapp/parse.ts`, replace

```ts
    case 'messages.update':
      return items.map((d) => parseUpdate(instance, d));
```

with

```ts
    case 'messages.update':
      return items.map((d) => parseUpdate(instance, d));
    case 'messages.delete':
      return items.map((d) => parseDelete(instance, d));
```

In `parseUpsert`, replace

```ts
  if (msg.editedMessage) return ignored('edit');
  if (isObj(msg.reactionMessage)) {
    // The office reacting from the phone would overwrite the contact's reaction (one slot per message).
    if (fromMe) return ignored('own reaction');
    const target = str(msg.reactionMessage.key?.id);
    if (!target) return ignored('invalid reaction');
    return { type: 'reaction', instance, targetExternalId: target, emoji: str(msg.reactionMessage.text) };
  }
```

with

```ts
  if (msg.editedMessage) return ignored('edit');
  if (isObj(msg.secretEncryptedMessage)) {
    // WhatsApp's newer edit format, encrypted (Baileys rc9 does not decrypt it): the target becomes "edited", its
    // new text unknown. secretEncType 2 = MESSAGE_EDIT (WAProto); 1 = EVENT_EDIT and anything else is skipped.
    const secret = msg.secretEncryptedMessage;
    const target = str(secret.targetMessageKey?.id);
    const isEdit = secret.secretEncType === 2 || secret.secretEncType === 'MESSAGE_EDIT';
    return isEdit && target ? { type: 'edit', instance, targetExternalId: target, fromMe, text: null } : ignored('secret message');
  }
  if (isObj(msg.reactionMessage)) {
    const target = str(msg.reactionMessage.key?.id);
    if (!target) return ignored('invalid reaction');
    // fromMe = the office reacted from its phone (or our own sendReaction's echo): it fills the office's slot.
    return { type: 'reaction', instance, targetExternalId: target, emoji: str(msg.reactionMessage.text), fromMe };
  }
```

Replace the whole `parseUpdate` function

```ts
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
```

with

```ts
function parseUpdate(instance: string, data: unknown): InboundEvent {
  if (!isObj(data)) return ignored('invalid update');
  const key = isObj(data.key) ? data.key : {};
  const remoteJid = str(data.remoteJid ?? key.remoteJid) ?? '';
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) return ignored('group status');
  const externalId = str(data.keyId) ?? str(key.id);
  // An edit by anyone (Baileys MESSAGE_EDIT): message.editedMessage.message is the new content. The remoteJid may
  // still be the @lid (Evolution only rewrites upserts), so the target is matched by id alone.
  if (isObj(data.message) && isObj(data.message.editedMessage)) {
    if (!externalId) return ignored('missing id');
    const text = editedText(data.message.editedMessage.message);
    const fromMe = (data.fromMe ?? key.fromMe) === true;
    return text === null ? ignored('edit without text') : { type: 'edit', instance, targetExternalId: externalId, fromMe, text };
  }
  // Statuses only matter for messages we sent; READ on an inbound message means the office read it on the phone.
  if ((data.fromMe ?? key.fromMe) === false) return ignored('status of inbound message');
  if (!externalId) return ignored('missing id');
  const status = STATUS.get(String(data.status));
  return status ? { type: 'status', instance, externalId, status } : ignored(`status ${String(data.status)}`);
}

/** New text of an edit: the content itself, or protocolMessage.editedMessage in the upsert shape. null = no text. */
function editedText(content: unknown): string | null {
  let m = unwrap(content);
  if (m && isObj(m.protocolMessage) && isObj(m.protocolMessage.editedMessage)) m = unwrap(m.protocolMessage.editedMessage);
  if (!m) return null;
  if (typeof m.conversation === 'string') return m.conversation;
  if (isObj(m.extendedTextMessage)) return str(m.extendedTextMessage.text);
  for (const k of ['imageMessage', 'videoMessage']) if (isObj(m[k])) return str(m[k].caption);
  return null;
}

/**
 * messages.delete: a revoke by the contact or the office phone (`data` = the key plus status, BS:1656), or our own
 * deleteMessageForEveryone (`data.key` = the key, `data.id` = Evolution's row id, BS:3804).
 */
function parseDelete(instance: string, data: unknown): InboundEvent {
  if (!isObj(data)) return ignored('invalid delete');
  const key = isObj(data.key) ? data.key : data;
  const remoteJid = str(key.remoteJid) ?? '';
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) return ignored('group delete');
  const target = str(key.id);
  if (!target) return ignored('missing id');
  return { type: 'revoke', instance, targetExternalId: target, fromMe: key.fromMe === true };
}
```

- [ ] **Step 6: Run the parse tests to verify they pass**

Run: `npm test -w server -- test/whatsapp/parse.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing ingest tests**

In `server/test/messages/ingest.test.ts`, replace

```ts
import { randomUUID } from 'node:crypto';
```

with

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
```

replace

```ts
import { channels, chats, contacts, messages } from '../../src/db/schema.js';
```

with

```ts
import { channels, chats, contacts, messageEdits, messages } from '../../src/db/schema.js';
```

replace

```ts
import { makeTestCtx, seedBasics } from '../helpers.js';
```

with

```ts
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
```

and append at the end of the file:

```ts
describe('handleInbound: office reactions, deletes and edits', () => {
  const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../fixtures/evolution/${name}.json`, import.meta.url), 'utf8'));
  const edits = () => ctx.db.select().from(messageEdits);
  const kinds = async (chatId: string, kind: string) => (await eventsOf(ctx, chatId)).filter((e) => e.kind === kind);
  async function stored(over: Partial<MessageEvent> = {}) {
    const ev = msg(over);
    await ingest(ev);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.externalId, ev.externalId));
    return row!;
  }

  it('puts a reaction made on the office phone in the office slot and keeps the contact one', async () => {
    const m = await stored();
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: '👍', fromMe: false });
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: '❤️', fromMe: true });
    expect((await allMessages())[0]).toMatchObject({ reaction: '👍', officeReaction: '❤️' });
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: null, fromMe: true });
    expect((await allMessages())[0]).toMatchObject({ reaction: '👍', officeReaction: null });
  });

  it('a revoke by the contact keeps the text, marks it deleted and logs the event once', async () => {
    const m = await stored({ body: 'mensagem que o contato apagou' });
    const revoke = { type: 'revoke' as const, instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false };
    await ingest(revoke);
    await ingest(revoke); // Evolution retry

    const [after] = await allMessages();
    expect(after).toMatchObject({ body: 'mensagem que o contato apagou', deletedSource: 'contact', deletedBy: null });
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(await kinds(m.chatId, 'message_deleted')).toMatchObject([{ authorId: null, data: { messageId: m.id, source: 'contact' } }]);
    expect(hubEvents('message.updated').at(-1)).toMatchObject({ chatId: m.chatId, messageId: m.id });
    expect(chatPublishes(m.chatId).length).toBeGreaterThan(1); // the ingest publish, then the delete's
  });

  it('a revoke from the office phone is source phone', async () => {
    const m = await stored({ direction: 'out', body: 'enviada pelo celular' });
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: true });
    expect((await allMessages())[0]).toMatchObject({ deletedSource: 'phone' });
    expect(await kinds(m.chatId, 'message_deleted')).toMatchObject([{ data: { source: 'phone' } }]);
  });

  it('a contact edit replaces the body and keeps the previous text in the history', async () => {
    const m = await stored({ body: 'Olá, preciso de ajuda' });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false, text: 'Olá, preciso de ajuda urgente' });

    const [after] = await allMessages();
    expect(after.body).toBe('Olá, preciso de ajuda urgente');
    expect(after.editedAt).toBeInstanceOf(Date);
    expect(await edits()).toMatchObject([
      { messageId: m.id, previousBody: 'Olá, preciso de ajuda', source: 'contact', editedBy: null, newTextUnavailable: false },
    ]);
    expect((await edits())[0]!.editedAt.getTime()).toBe(after.editedAt!.getTime());
    expect(await kinds(m.chatId, 'message_edited')).toMatchObject([{ data: { messageId: m.id, source: 'contact' } }]);
  });

  it('matches an edit by WhatsApp id even when it carries an @lid remoteJid', async () => {
    await ingest(...parseEvolutionWebhook(fixture('text-in')));
    await ingest(...parseEvolutionWebhook(fixture('edit-update-in')));
    expect((await allMessages())[0]!.body).toBe('Olá, preciso de ajuda urgente');
  });

  it('the encrypted edit format marks the target, keeps its text and adds no bubble', async () => {
    await ingest(...parseEvolutionWebhook(fixture('text-in')));
    await ingest(...parseEvolutionWebhook(fixture('secret-edit-in')));

    const all = await allMessages();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ externalId: 'MSG-TEXT-IN', kind: 'text', body: 'Olá, preciso de ajuda' });
    expect(all[0]!.editedAt).toBeInstanceOf(Date);
    expect(await edits()).toMatchObject([{ previousBody: 'Olá, preciso de ajuda', source: 'contact', newTextUnavailable: true }]);
  });

  it('ignores the echoes of the office actions (Review Focus 1)', async () => {
    const m = await stored({ direction: 'out', body: 'apagada pelo atendente' });
    await ctx.db
      .update(messages)
      .set({ deletedAt: new Date(), deletedBy: seed.agentA.id, deletedSource: 'office', officeReaction: '👍' })
      .where(eq(messages.id, m.id));
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: true });
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: '👍', fromMe: true });
    const [after] = await ctx.db.select().from(messages).where(eq(messages.id, m.id));
    expect(after).toMatchObject({ deletedSource: 'office', deletedBy: seed.agentA.id, officeReaction: '👍' });
    expect(await kinds(m.chatId, 'message_deleted')).toEqual([]);

    const n = await stored({ direction: 'out', body: 'já editado pelo sistema' });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: n.externalId!, fromMe: true, text: 'já editado pelo sistema' });
    expect(await edits()).toEqual([]);
    expect(await kinds(n.chatId, 'message_edited')).toEqual([]);
  });

  it('ignores unknown targets and never edits a deleted message', async () => {
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: 'NAO-EXISTE', fromMe: false });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: 'NAO-EXISTE', fromMe: false, text: 'x' });
    expect(hubEvents('message.updated')).toHaveLength(0);

    const m = await stored({ body: 'apagada' });
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false, text: 'editada depois' });
    expect((await allMessages())[0]!.body).toBe('apagada');
    expect(await edits()).toEqual([]);
  });
});
```

- [ ] **Step 8: Run them to verify they fail**

Run: `npm test -w server -- test/messages/ingest.test.ts`
Expected: FAIL. The office reaction overwrites `reaction`, and `revoke`/`edit` events fall through to `ingestMessage` and throw on missing fields (or change nothing).

- [ ] **Step 9: Apply them in ingest**

In `server/src/messages/ingest.ts`, replace

```ts
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
```

with

```ts
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
```

replace

```ts
import { chats, contacts, messages } from '../db/schema.js';
```

with

```ts
import { chats, contacts, messageEdits, messages } from '../db/schema.js';
import { addEvent } from '../inbox/events.js';
```

replace

```ts
type StatusEvent = Extract<InboundEvent, { type: 'status' }>;
```

with

```ts
type StatusEvent = Extract<InboundEvent, { type: 'status' }>;
type RevokeEvent = Extract<InboundEvent, { type: 'revoke' }>;
type EditEvent = Extract<InboundEvent, { type: 'edit' }>;
```

In `handleInbound`, replace

```ts
    else if (ev.type === 'reaction') await applyReaction(ctx, channel.id, ev.targetExternalId, ev.emoji);
    else await ingestMessage(ctx, channel.id, ev, h);
```

with

```ts
    else if (ev.type === 'reaction') await applyReaction(ctx, channel.id, ev.targetExternalId, ev.emoji, ev.fromMe === true);
    else if (ev.type === 'revoke') await applyRevoke(ctx, channel.id, ev);
    else if (ev.type === 'edit') await applyEdit(ctx, channel.id, ev);
    else await ingestMessage(ctx, channel.id, ev, h);
```

Replace the whole `applyReaction`

```ts
/** Reactions never create chats nor touch unread/waiting (§5.1). Unknown target → ignored. */
async function applyReaction(ctx: AppCtx, channelId: string, targetExternalId: string, emoji: string | null): Promise<void> {
  const [row] = await ctx.db
    .update(messages)
    .set({ reaction: emoji || null })
    .where(and(eq(messages.channelId, channelId), eq(messages.externalId, targetExternalId)))
    .returning({ id: messages.id, chatId: messages.chatId });
  if (row) await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
}
```

with

```ts
/**
 * Reactions never create chats nor touch unread/waiting (§5.1). Unknown target → ignored. `office` (fromMe) fills the
 * office's slot, so a reaction made on the office phone never overwrites the contact's (spec §3).
 */
async function applyReaction(
  ctx: AppCtx,
  channelId: string,
  targetExternalId: string,
  emoji: string | null,
  office = false,
): Promise<void> {
  const value = emoji || null;
  const [row] = await ctx.db
    .update(messages)
    .set(office ? { officeReaction: value } : { reaction: value })
    .where(and(eq(messages.channelId, channelId), eq(messages.externalId, targetExternalId)))
    .returning({ id: messages.id, chatId: messages.chatId });
  if (row) await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
}

/** fromMe = the office phone. The office's own API actions are saved before their echo arrives (messages/actions.ts). */
const changeSource = (fromMe: boolean): 'phone' | 'contact' => (fromMe ? 'phone' : 'contact');

/**
 * Spec §4: deleted for everyone by the contact or the office phone. The text stays; deleted_at/source mark it and a
 * message_deleted event goes to the timeline. A row that is already deleted (a retried webhook, or the echo of our own
 * delete, claimed before the Evolution call) and an unknown target change nothing.
 */
async function applyRevoke(ctx: AppCtx, channelId: string, ev: RevokeEvent): Promise<void> {
  const source = changeSource(ev.fromMe);
  const row = await ctx.db.transaction(async (tx) => {
    const [r] = await tx
      .update(messages)
      .set({ deletedAt: new Date(), deletedSource: source })
      .where(and(eq(messages.channelId, channelId), eq(messages.externalId, ev.targetExternalId), isNull(messages.deletedAt)))
      .returning({ id: messages.id, chatId: messages.chatId });
    if (r) await addEvent(tx, r.chatId, 'message_deleted', { messageId: r.id, source }, null);
    return r;
  });
  if (!row) return;
  await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
  await ctx.hub.publishChat(row.chatId); // an open timeline refetches on chat.updated and shows the event
}

/**
 * Spec §5: edited by the contact or the office phone. The previous text goes to message_edits; text null (WhatsApp's
 * encrypted format) keeps the body and flags the new text as unavailable. A text equal to the current body is the echo
 * of our own edit (saved before the call) or a retried webhook: nothing changes. Deleted messages are never edited.
 */
async function applyEdit(ctx: AppCtx, channelId: string, ev: EditEvent): Promise<void> {
  const source = changeSource(ev.fromMe);
  const row = await ctx.db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.externalId, ev.targetExternalId)))
      .for('update');
    if (!target || target.deletedAt) return null;
    if (ev.text !== null && ev.text === target.body) return null;
    // ponytail: a retried webhook of an encrypted edit (text null) adds a second history row; dedupe by the edit's own
    // WhatsApp id if that ever shows up. The chat preview keeps the old text too.
    const [edit] = await tx
      .insert(messageEdits)
      .values({ messageId: target.id, previousBody: target.body, source, newTextUnavailable: ev.text === null })
      .returning({ editedAt: messageEdits.editedAt });
    await tx
      .update(messages)
      .set({ editedAt: edit!.editedAt, ...(ev.text !== null ? { body: ev.text } : {}) })
      .where(eq(messages.id, target.id));
    await addEvent(tx, target.chatId, 'message_edited', { messageId: target.id, source }, null);
    return target;
  });
  if (!row) return;
  await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
  await ctx.hub.publishChat(row.chatId);
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -w server -- test/messages/ingest.test.ts test/whatsapp/parse.test.ts test/webhooks/routes.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add server/src/whatsapp/types.ts server/src/whatsapp/parse.ts server/src/messages/ingest.ts server/test/fixtures/evolution/delete-in.json server/test/fixtures/evolution/delete-api.json server/test/fixtures/evolution/edit-update-in.json server/test/fixtures/evolution/secret-edit-in.json server/test/whatsapp/parse.test.ts server/test/messages/ingest.test.ts
git commit -m "feat(server): apply office-phone reactions and contact or phone deletes and edits from webhooks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: React and delete for everyone (API)

**Files:**
- Create: `server/src/messages/actions.ts`
- Modify: `server/src/messages/send.ts` (`callGateway` at lines 130-158 gets its target from the new `gatewayTarget`; the quoted-message check at lines 271-279)
- Modify: `server/src/chats/routes.ts` (imports at lines 1-14, body schemas after `noteBody` at line 62, routes after `/resend` at lines 166-168)
- Create: `server/test/messages/actions-seed.ts`
- Test: `server/test/messages/actions.test.ts` (create)

**Interfaces:**
- Consumes:
  - Task 1: `reactBlock`, `deleteBlock`, `isSingleEmoji`, `DELETED_REASON`, `ActionBlock`.
  - Task 2: `messages.officeReaction` and the `deleted*` columns.
  - Task 3: `ctx.wa.sendReaction`, `ctx.wa.deleteForEveryone`, `MessageKeyRef`.
  - Existing: `getChatForUser`, `addEvent`, `toMessageDto`, `conflict` / `badRequest` / `notFound` / `HttpError`.
  - Existing test helpers: `seedChat` (`test/chats/seed.ts`), `makeTestCtx`, `makeTestApp`, `seedBasics`, `loginAs`.
- Produces:
  - `gatewayTarget(db, chatId): Promise<{ instance; address }>` in `send.ts`;
  - `reactToMessage` and `deleteMessageForEveryone` in `actions.ts`;
  - routes `POST /api/messages/:id/reaction` and `DELETE /api/messages/:id`;
  - in `actions.ts`, private helpers that Tasks 6-8 reuse: `loadTarget(ctx, user, messageId): Promise<{ msg: MessageRow; chat: ChatRow }>`, `asTarget(msg)`, `refuse(block)`, `keyOf(ctx, msg)` and `viaWhatsApp(action: 'reaction' | 'delete' | 'edit', messageId, run)`;
  - test seed `server/test/messages/actions-seed.ts`: `PHONE`, `Ctx`, `ActionsWorld { ctx; app; s; chatId; contactId; headers }`, `setupActions()`, `seedMsg(w, extra?)`, `seedFile(w, rel, bytes)`, `seedWaitingRun(w, chatId?, contactId?)` and `minutesAgo(n)`.

- [ ] **Step 1: Create the test seed**

Create `server/test/messages/actions-seed.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { botRuns, botVersions, bots, messages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

export const PHONE = '5565999999999';
export type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

export interface ActionsWorld {
  ctx: Ctx;
  app: FastifyInstance;
  s: Awaited<ReturnType<typeof seedBasics>>;
  chatId: string;
  contactId: string;
  /** agentA's session (Origin included). */
  headers: Record<string, string>;
}

/** agentA's open chat (sector A, owner agentA) with a phone contact. */
export async function setupActions(): Promise<ActionsWorld> {
  const ctx = await makeTestCtx();
  const s = await seedBasics(ctx);
  const { app } = await makeTestApp(ctx);
  const { chatId, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: PHONE });
  const { headers } = await loginAs(app, s.agentA.email);
  return { ctx, app, s, chatId, contactId, headers };
}

export const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

let seq = 0;
/** A stored message in the world's chat. Defaults: an `out` text by agentA, sent 1 min ago, with a WhatsApp id. */
export async function seedMsg(w: ActionsWorld, extra: Partial<typeof messages.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await w.ctx.db.insert(messages).values({
    id, chatId: w.chatId, channelId: w.s.channelId, direction: 'out', kind: 'text', body: `texto ${seq}`,
    authorId: w.s.agentA.id, externalId: `WA-${seq}`, status: 'sent', sentAt: minutesAgo(1), ...extra,
  });
  return id;
}

/** Writes `bytes` under mediaDir and returns the relative path, to put in messages.media_path. */
export async function seedFile(w: ActionsWorld, rel: string, bytes: Buffer): Promise<string> {
  await mkdir(dirname(join(w.ctx.config.mediaDir, rel)), { recursive: true });
  await writeFile(join(w.ctx.config.mediaDir, rel), bytes);
  return rel;
}

/** A chatbot run waiting for the contact: with the default behavior ('ask'), sends in that chat get 409 BOT_RUNNING. */
export async function seedWaitingRun(w: ActionsWorld, chatId = w.chatId, contactId = w.contactId): Promise<void> {
  const [bot] = await w.ctx.db.insert(bots).values({ name: `Recepção ${randomUUID().slice(0, 8)}` }).returning();
  const [version] = await w.ctx.db
    .insert(botVersions)
    .values({ botId: bot!.id, number: 1, graph: { nodes: [], edges: [] }, valid: true })
    .returning();
  await w.ctx.db
    .insert(botRuns)
    .values({ botId: bot!.id, versionId: version!.id, chatId, contactId, state: 'waiting_reply', currentNodeId: 'n1' });
}
```

- [ ] **Step 2: Write the failing route tests**

Create `server/test/messages/actions.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, messages } from '../../src/db/schema.js';
import { loginAs } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { PHONE, minutesAgo, seedMsg, setupActions, type ActionsWorld } from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const call = (method: 'POST' | 'DELETE' | 'PATCH' | 'GET', url: string, payload?: object, headers = w.headers) =>
  w.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const row = async (id: string) => (await w.ctx.db.select().from(messages).where(eq(messages.id, id)))[0]!;
const sentBy = (method: string) => w.ctx.wa.sent.filter((s) => s.method === method);
const eventsOfKind = async (kind: string) => (await eventsOf(w.ctx, w.chatId)).filter((e) => e.kind === kind);

describe('POST /api/messages/:id/reaction', () => {
  const react = (id: string, emoji: string, headers = w.headers) => call('POST', `/api/messages/${id}/reaction`, { emoji }, headers);

  it('reacts, swaps and removes the office reaction on WhatsApp', async () => {
    const id = await seedMsg(w, { direction: 'in', authorId: null, externalId: 'WA-IN' });

    const first = await react(id, '👍');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id, officeReaction: '👍', reaction: null });
    expect((await react(id, '❤️')).json().officeReaction).toBe('❤️');
    expect((await react(id, '❤️')).json().officeReaction).toBeNull(); // the same emoji again removes it

    const key = { address: PHONE, externalId: 'WA-IN', fromMe: false };
    expect(sentBy('sendReaction').map((s) => s.payload)).toEqual([
      { key, emoji: '👍' },
      { key, emoji: '❤️' },
      { key, emoji: '' },
    ]);
    expect(w.ctx.hub.events.filter((e) => e.type === 'message.updated' && e.messageId === id)).toHaveLength(3);
  });

  it('refuses a non-emoji, a pending send, a note, a hidden chat and a closed chat', async () => {
    const id = await seedMsg(w);
    expect((await react(id, 'ok')).json()).toEqual({ error: 'Escolha um emoji' });
    const pending = await seedMsg(w, { status: 'pending', externalId: null });
    expect((await react(pending, '👍')).statusCode).toBe(409);
    const note = await seedMsg(w, { kind: 'note', externalId: null });
    expect((await react(note, '👍')).statusCode).toBe(409);
    const bruno = await loginAs(w.app, w.s.agentB.email);
    expect((await react(id, '👍', bruno.headers)).statusCode).toBe(404);
    await w.ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, w.chatId));
    const closed = await react(id, '👍');
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toEqual({ error: 'Conversa finalizada' });
    expect(sentBy('sendReaction')).toEqual([]);
  });

  it('turns an Evolution failure into a 502 in Portuguese and logs no text', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'texto do cliente' });
    w.ctx.wa.failNext(new Error('Evolution POST /message/sendReaction/talk-test failed: 500 {"text":"texto do cliente"}'));

    const res = await react(id, '👍');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível reagir no WhatsApp. Tente de novo.' });
    expect((await row(id)).officeReaction).toBeNull();
    expect(logged).toHaveBeenCalledWith('message reaction failed', { messageId: id, err: 'Error' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('texto do cliente');
    logged.mockRestore();
  });
});

describe('DELETE /api/messages/:id', () => {
  const del = (id: string) => call('DELETE', `/api/messages/${id}`);

  it('deletes an office message for everyone, keeps its text and logs who did it', async () => {
    const id = await seedMsg(w, { body: 'Mensagem errada', externalId: 'WA-OUT', sentAt: minutesAgo(60) });

    const res = await del(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, body: 'Mensagem errada', deleted: { source: 'office', byName: w.s.agentA.name } });
    expect(sentBy('deleteForEveryone').map((s) => s.payload)).toEqual([{ key: { address: PHONE, externalId: 'WA-OUT', fromMe: true } }]);
    expect(await eventsOfKind('message_deleted')).toMatchObject([
      { authorId: w.s.agentA.id, data: { messageId: id, source: 'office' } },
    ]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'message.updated', chatId: w.chatId, messageId: id });
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat', chatId: w.chatId });
  });

  it('deletes bot and phone sends too, never inbound messages', async () => {
    const bot = await seedMsg(w, { authorId: null });
    expect((await del(bot)).statusCode).toBe(200);
    const inbound = await seedMsg(w, { direction: 'in', authorId: null });
    const res = await del(inbound);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Só dá para apagar mensagens enviadas pelo escritório' });
  });

  it('stops at 48 h with the hint text', async () => {
    const id = await seedMsg(w, { sentAt: minutesAgo(48 * 60 + 1) });
    expect((await del(id)).json()).toEqual({ error: 'Só até 48 h após o envio' });
    expect(sentBy('deleteForEveryone')).toEqual([]);
  });

  it('a second delete is 409 and calls Evolution once (Review Focus 4)', async () => {
    const id = await seedMsg(w);
    expect((await del(id)).statusCode).toBe(200);
    const again = await del(id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'Mensagem apagada' });
    expect(sentBy('deleteForEveryone')).toHaveLength(1);
  });

  it('rolls back when Evolution fails (Review Focus 3)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'segredo do cliente' });
    w.ctx.wa.failNext();

    const res = await del(id);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível apagar no WhatsApp. Tente de novo.' });
    expect(await row(id)).toMatchObject({ deletedAt: null, deletedBy: null, deletedSource: null });
    expect(await eventsOfKind('message_deleted')).toEqual([]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('segredo');
    logged.mockRestore();
  });

  it('a deleted message can no longer be quoted', async () => {
    const id = await seedMsg(w);
    await del(id);
    const res = await call('POST', `/api/chats/${w.chatId}/messages`, { text: 'Sobre aquela', replyToId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Mensagem apagada não pode ser citada' });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test -w server -- test/messages/actions.test.ts`
Expected: FAIL with 404 `Route POST:/api/messages/…/reaction not found` (and the same for DELETE).

- [ ] **Step 4: Export `gatewayTarget` and refuse quoting a deleted message**

In `server/src/messages/send.ts`, replace

```ts
async function callGateway(ctx: AppCtx, msg: MessageRow): Promise<SendResult> {
  const [target] = await ctx.db
    .select({ phone: contacts.phone, lid: contacts.lid, instance: channels.evolutionInstance })
    .from(chats)
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(channels, eq(channels.id, chats.channelId))
    .where(eq(chats.id, msg.chatId));
  const to = waAddress(target);
  if (!target || !to) throw new Error('Contato sem telefone');
  const quoted = await quotedRef(ctx.db, msg.replyToId);

  if (msg.kind === 'text') return ctx.wa.sendText(target.instance, to, msg.body ?? '', quoted);

  if (!msg.mediaPath) throw new Error('Arquivo não encontrado');
  const base64 = (await readFile(join(ctx.config.mediaDir, msg.mediaPath))).toString('base64');
  if (msg.kind === 'audio') return ctx.wa.sendAudio(target.instance, to, base64, quoted);
  return ctx.wa.sendMedia(
    target.instance,
```

with

```ts
/** Evolution instance and WhatsApp address of a chat's contact; throws 'Contato sem telefone' with neither phone nor LID. */
export async function gatewayTarget(db: Db, chatId: string): Promise<{ instance: string; address: string }> {
  const [target] = await db
    .select({ phone: contacts.phone, lid: contacts.lid, instance: channels.evolutionInstance })
    .from(chats)
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(channels, eq(channels.id, chats.channelId))
    .where(eq(chats.id, chatId));
  const address = waAddress(target);
  if (!target || !address) throw new Error('Contato sem telefone');
  return { instance: target.instance, address };
}

async function callGateway(ctx: AppCtx, msg: MessageRow): Promise<SendResult> {
  const { instance, address: to } = await gatewayTarget(ctx.db, msg.chatId);
  const quoted = await quotedRef(ctx.db, msg.replyToId);

  if (msg.kind === 'text') return ctx.wa.sendText(instance, to, msg.body ?? '', quoted);

  if (!msg.mediaPath) throw new Error('Arquivo não encontrado');
  const base64 = (await readFile(join(ctx.config.mediaDir, msg.mediaPath))).toString('base64');
  if (msg.kind === 'audio') return ctx.wa.sendAudio(instance, to, base64, quoted);
  return ctx.wa.sendMedia(
    instance,
```

and replace

```ts
    const [orig] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, input.replyToId), eq(messages.chatId, chatId)));
    if (!orig) throw badRequest('Mensagem citada não encontrada');
    replyToId = orig.id;
```

with

```ts
    const [orig] = await ctx.db
      .select({ id: messages.id, deletedAt: messages.deletedAt })
      .from(messages)
      .where(and(eq(messages.id, input.replyToId), eq(messages.chatId, chatId)));
    if (!orig) throw badRequest('Mensagem citada não encontrada');
    if (orig.deletedAt) throw badRequest('Mensagem apagada não pode ser citada'); // spec §4
    replyToId = orig.id;
```

- [ ] **Step 5: Create the actions module**

Create `server/src/messages/actions.ts`:

```ts
// Message actions by an agent (spec 2026-10-16 §3–§7). Rules come from @talk/shared (the bubble menu uses the same).
// Delete and edit change our DB *before* calling Evolution and roll back on failure: the webhook echo of the call
// then finds the work done and changes nothing (ingest applyRevoke/applyEdit).
import { and, eq, isNull } from 'drizzle-orm';
import { DELETED_REASON, deleteBlock, isSingleEmoji, reactBlock, type ActionBlock, type MessageDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { messages } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/http-error.js';
import type { MessageKeyRef } from '../whatsapp/types.js';
import { toMessageDto } from './dto.js';
import { gatewayTarget } from './send.js';

type MessageRow = typeof messages.$inferSelect;

/** Spec §2: 404 unless canSee; never in a closed chat. Notes are refused by every rule. */
async function loadTarget(ctx: AppCtx, user: AuthUser, messageId: string): Promise<{ msg: MessageRow; chat: ChatRow }> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  const chat = await getChatForUser(ctx, user, msg.chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada');
  return { msg, chat };
}

const asTarget = (msg: MessageRow) => ({ ...msg, deleted: msg.deletedAt });

function refuse(block: ActionBlock | null): void {
  if (block) throw conflict(block.reason);
}

async function keyOf(ctx: AppCtx, msg: MessageRow): Promise<{ instance: string; key: MessageKeyRef }> {
  if (!msg.externalId) throw new Error('Mensagem sem id do WhatsApp'); // the rules already exclude notes and pending/failed
  const { instance, address } = await gatewayTarget(ctx.db, msg.chatId);
  return { instance, key: { address, externalId: msg.externalId, fromMe: msg.direction === 'out' } };
}

const WA_FAILED = {
  reaction: 'Não foi possível reagir no WhatsApp. Tente de novo.',
  delete: 'Não foi possível apagar no WhatsApp. Tente de novo.',
  edit: 'Não foi possível editar no WhatsApp. Tente de novo.',
} as const;

/** Any failure on the way to Evolution → 502 in pt-BR. The log has the message id and the error name, never text. */
async function viaWhatsApp(action: keyof typeof WA_FAILED, messageId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`message ${action} failed`, { messageId, err: err instanceof Error ? err.name : typeof err });
    throw new HttpError(502, WA_FAILED[action]);
  }
}

/** Spec §3: the office's own reaction (one per message, next to the contact's). '' or the same emoji again removes it. */
export async function reactToMessage(ctx: AppCtx, user: AuthUser, messageId: string, emoji: string): Promise<MessageDto> {
  if (emoji !== '' && !isSingleEmoji(emoji)) throw badRequest('Escolha um emoji');
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(reactBlock(asTarget(msg)));
  const next = emoji === msg.officeReaction ? '' : emoji;
  await viaWhatsApp('reaction', msg.id, async () => {
    const { instance, key } = await keyOf(ctx, msg);
    await ctx.wa.sendReaction(instance, key, next);
  });
  // The echo (a fromMe reactionMessage) writes the same value into the same slot: harmless.
  const [row] = await ctx.db.update(messages).set({ officeReaction: next || null }).where(eq(messages.id, msg.id)).returning();
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  return toMessageDto(ctx.db, row!);
}

/** Spec §4: delete for everyone. The text stays visible to the team with "Apagada por <nome>". */
export async function deleteMessageForEveryone(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto> {
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(deleteBlock(asTarget(msg), Date.now()));
  // Claim first. A double click or a second agent gets 409; the MESSAGES_DELETE echo of this very call finds
  // deleted_at set and changes nothing.
  const [claimed] = await ctx.db
    .update(messages)
    .set({ deletedAt: new Date(), deletedBy: user.id, deletedSource: 'office' })
    .where(and(eq(messages.id, msg.id), isNull(messages.deletedAt)))
    .returning();
  if (!claimed) throw conflict(DELETED_REASON);
  try {
    await viaWhatsApp('delete', msg.id, async () => {
      const { instance, key } = await keyOf(ctx, msg);
      await ctx.wa.deleteForEveryone(instance, key);
    });
  } catch (err) {
    await ctx.db.update(messages).set({ deletedAt: null, deletedBy: null, deletedSource: null }).where(eq(messages.id, msg.id));
    throw err;
  }
  await addEvent(ctx.db, chat.id, 'message_deleted', { messageId: msg.id, source: 'office' }, user.id);
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  await ctx.hub.publishChat(chat.id); // an open timeline refetches on chat.updated and shows the event
  return toMessageDto(ctx.db, claimed);
}
```

- [ ] **Step 6: Add the routes**

In `server/src/chats/routes.ts`, replace

```ts
import { addNote, resendMessage, sendAgentMessage, type SendInput } from '../messages/send.js';
```

with

```ts
import { deleteMessageForEveryone, reactToMessage } from '../messages/actions.js';
import { addNote, resendMessage, sendAgentMessage, type SendInput } from '../messages/send.js';
```

after

```ts
const noteBody = z.object({ text: z.string().trim().min(1).max(4096) });
```

add

```ts
/** Spec §3: one emoji, or '' to remove (isSingleEmoji checks it in reactToMessage). */
const reactionBody = z.object({ emoji: z.string().max(32) });
```

and replace

```ts
    r.post('/api/messages/:id/resend', async (req) =>
      resendMessage(ctx, req.user, idParams.parse(req.params).id),
    );
```

with

```ts
    r.post('/api/messages/:id/resend', async (req) =>
      resendMessage(ctx, req.user, idParams.parse(req.params).id),
    );

    r.post('/api/messages/:id/reaction', async (req) =>
      reactToMessage(ctx, req.user, idParams.parse(req.params).id, reactionBody.parse(req.body).emoji),
    );

    r.delete('/api/messages/:id', async (req) => deleteMessageForEveryone(ctx, req.user, idParams.parse(req.params).id));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/messages/actions.test.ts test/messages/send.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/messages/actions.ts server/src/messages/send.ts server/src/chats/routes.ts server/test/messages/actions-seed.ts server/test/messages/actions.test.ts
git commit -m "feat(server): react to and delete messages for everyone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Edit and the version history (API)

**Files:**
- Modify: `server/src/messages/actions.ts` (the import block at the top; new functions at the end)
- Modify: `server/src/chats/routes.ts` (the actions import, a new body schema, two routes)
- Test: `server/test/messages/actions.test.ts` (imports; new `describe` at the end)

**Interfaces:**
- Consumes:
  - Task 1: `editBlock`, `MessageEditDto`.
  - Task 2: table `messageEdits`.
  - Task 3: `ctx.wa.editText`.
  - Task 4: `handleInbound` with `edit` events (the echo test).
  - Task 5: `loadTarget`, `asTarget`, `refuse`, `keyOf`, `viaWhatsApp`, the test seed.
  - Existing: `enableSeeAll` (`test/helpers.ts`).
- Produces: `editMessage(ctx, user, messageId, text)`, `listMessageEdits(ctx, user, messageId)`, `PATCH /api/messages/:id` `{ text }` and `GET /api/messages/:id/edits`.

- [ ] **Step 1: Write the failing tests**

In `server/test/messages/actions.test.ts`, replace

```ts
import { loginAs } from '../helpers.js';
```

with

```ts
import { handleInbound } from '../../src/messages/ingest.js';
import { enableSeeAll, loginAs } from '../helpers.js';
```

and append at the end of the file:

```ts
describe('PATCH /api/messages/:id and GET /api/messages/:id/edits', () => {
  const edit = (id: string, text: string, headers = w.headers) => call('PATCH', `/api/messages/${id}`, { text }, headers);
  const history = (id: string, headers = w.headers) => call('GET', `/api/messages/${id}/edits`, undefined, headers);

  it('edits the author text on WhatsApp and keeps the previous version', async () => {
    const id = await seedMsg(w, { body: 'Reunião às 14h', externalId: 'WA-E', sentAt: minutesAgo(5) });

    const res = await edit(id, 'Reunião às 15h');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'Reunião às 15h', edited: { source: 'office', newTextUnavailable: false } });
    expect(sentBy('editText').map((s) => s.payload)).toEqual([
      { key: { address: PHONE, externalId: 'WA-E', fromMe: true }, text: 'Reunião às 15h' },
    ]);
    expect((await history(id)).json()).toMatchObject([
      { previousBody: 'Reunião às 14h', source: 'office', editedByName: w.s.agentA.name, newTextUnavailable: false },
    ]);
    expect(await eventsOfKind('message_edited')).toMatchObject([{ authorId: w.s.agentA.id, data: { messageId: id, source: 'office' } }]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat', chatId: w.chatId });
  });

  it('edits the caption of an image', async () => {
    const id = await seedMsg(w, { kind: 'image', body: 'Foto 1', mediaPath: '2026/10/x.jpg', mediaMime: 'image/jpeg' });
    expect((await edit(id, 'Foto 2')).json()).toMatchObject({ kind: 'image', body: 'Foto 2' });
  });

  it('refuses after 15 minutes, other authors, bots, documents and empty or long text', async () => {
    expect((await edit(await seedMsg(w, { sentAt: minutesAgo(16) }), 'tarde demais')).json()).toEqual({
      error: 'Só até 15 min após o envio',
    });
    await enableSeeAll(w.ctx, w.s.admin);
    const admin = await loginAs(w.app, w.s.admin.email);
    const recent = await seedMsg(w);
    expect((await edit(recent, 'outro autor', admin.headers)).json()).toEqual({ error: 'Só dá para editar mensagens enviadas por você' });
    expect((await edit(await seedMsg(w, { authorId: null }), 'x')).json()).toEqual({
      error: 'Só dá para editar mensagens enviadas por você',
    });
    const doc = await seedMsg(w, { kind: 'document', body: 'Segue', mediaPath: '2026/10/a.pdf' });
    expect((await edit(doc, 'x')).json()).toEqual({ error: 'Só dá para editar texto ou legenda' });
    expect((await edit(recent, '   ')).statusCode).toBe(400);
    expect((await edit(recent, 'x'.repeat(4097))).statusCode).toBe(400);
    expect(sentBy('editText')).toEqual([]);
  });

  it('the same text again changes nothing and calls nobody', async () => {
    const id = await seedMsg(w, { body: 'igual' });
    expect((await edit(id, 'igual')).statusCode).toBe(200);
    expect(sentBy('editText')).toEqual([]);
    expect((await history(id)).json()).toEqual([]);
  });

  it('rolls back the text and the history when Evolution fails (Review Focus 3)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'Valor: R$ 100' });
    w.ctx.wa.failNext();

    const res = await edit(id, 'Valor: R$ 200');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível editar no WhatsApp. Tente de novo.' });
    expect(await row(id)).toMatchObject({ body: 'Valor: R$ 100', editedAt: null });
    expect((await history(id)).json()).toEqual([]);
    expect(await eventsOfKind('message_edited')).toEqual([]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('R$');
    logged.mockRestore();
  });

  it('the webhook echo of our own edit adds no second version (Review Focus 1)', async () => {
    const id = await seedMsg(w, { body: 'antes', externalId: 'WA-ECHO' });
    await edit(id, 'depois');
    await handleInbound(w.ctx, [{ type: 'edit', instance: w.s.instance, targetExternalId: 'WA-ECHO', fromMe: true, text: 'depois' }]);
    expect((await history(id)).json()).toHaveLength(1);
  });

  it('lists contact edits newest first, the encrypted one as text unavailable; 404 for a hidden chat', async () => {
    const id = await seedMsg(w, { direction: 'in', authorId: null, body: 'oi', externalId: 'WA-C' });
    await handleInbound(w.ctx, [{ type: 'edit', instance: w.s.instance, targetExternalId: 'WA-C', fromMe: false, text: 'oi, tudo bem?' }]);
    await handleInbound(w.ctx, [{ type: 'edit', instance: w.s.instance, targetExternalId: 'WA-C', fromMe: false, text: null }]);

    expect((await history(id)).json()).toMatchObject([
      { previousBody: 'oi, tudo bem?', source: 'contact', editedByName: null, newTextUnavailable: true },
      { previousBody: 'oi', source: 'contact', editedByName: null, newTextUnavailable: false },
    ]);
    const bruno = await loginAs(w.app, w.s.agentB.email);
    expect((await history(id, bruno.headers)).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/messages/actions.test.ts`
Expected: FAIL with 404 `Route PATCH:/api/messages/… not found` and `Route GET:/api/messages/…/edits not found`.

- [ ] **Step 3: Implement edit and history**

In `server/src/messages/actions.ts`, replace

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { DELETED_REASON, deleteBlock, isSingleEmoji, reactBlock, type ActionBlock, type MessageDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { messages } from '../db/schema.js';
```

with

```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  DELETED_REASON, deleteBlock, editBlock, isSingleEmoji, reactBlock, type ActionBlock, type MessageDto, type MessageEditDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { messageEdits, messages, users } from '../db/schema.js';
```

and append at the end of the file:

```ts
/**
 * Spec §5: the author edits a text or caption within 15 min. The new text and the history row are saved first (so the
 * MESSAGES_UPDATE echo carries the body we already hold); a failed Evolution call puts both back.
 */
export async function editMessage(ctx: AppCtx, user: AuthUser, messageId: string, text: string): Promise<MessageDto> {
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(editBlock(asTarget(msg), user.id, Date.now()));
  if (text === msg.body) return toMessageDto(ctx.db, msg); // nothing to change: no WhatsApp call, no history row

  const sameBody = msg.body === null ? isNull(messages.body) : eq(messages.body, msg.body);
  const edit = await ctx.db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(messageEdits)
      .values({ messageId: msg.id, previousBody: msg.body, source: 'office', editedBy: user.id })
      .returning({ id: messageEdits.id, editedAt: messageEdits.editedAt });
    const [changed] = await tx
      .update(messages)
      .set({ body: text, editedAt: saved!.editedAt })
      .where(and(eq(messages.id, msg.id), isNull(messages.deletedAt), sameBody))
      .returning({ id: messages.id });
    // Someone (another tab, a webhook) changed it since we read it: the throw rolls the history row back too.
    if (!changed) throw conflict('A mensagem mudou. Recarregue e tente de novo.');
    return saved!;
  });
  try {
    await viaWhatsApp('edit', msg.id, async () => {
      const { instance, key } = await keyOf(ctx, msg);
      await ctx.wa.editText(instance, key, text);
    });
  } catch (err) {
    await ctx.db.transaction(async (tx) => {
      await tx.delete(messageEdits).where(eq(messageEdits.id, edit.id));
      await tx.update(messages).set({ body: msg.body, editedAt: msg.editedAt }).where(eq(messages.id, msg.id));
    });
    throw err;
  }
  // ponytail: chats.last_message_preview keeps the old text when the last message is edited; refresh it if anyone notices.
  await addEvent(ctx.db, chat.id, 'message_edited', { messageId: msg.id, source: 'office' }, user.id);
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  await ctx.hub.publishChat(chat.id);
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, msg.id));
  return toMessageDto(ctx.db, row!);
}

/** GET /api/messages/:id/edits: the text before each edit, newest first. Reading is fine in a closed chat too. */
export async function listMessageEdits(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageEditDto[]> {
  const [msg] = await ctx.db.select({ chatId: messages.chatId }).from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  await getChatForUser(ctx, user, msg.chatId);
  const rows = await ctx.db
    .select({
      id: messageEdits.id,
      previousBody: messageEdits.previousBody,
      source: messageEdits.source,
      editedByName: users.name,
      newTextUnavailable: messageEdits.newTextUnavailable,
      editedAt: messageEdits.editedAt,
    })
    .from(messageEdits)
    .leftJoin(users, eq(users.id, messageEdits.editedBy))
    .where(eq(messageEdits.messageId, messageId))
    .orderBy(desc(messageEdits.editedAt));
  return rows.map((r) => ({ ...r, editedByName: r.editedByName ?? null, editedAt: r.editedAt.toISOString() }));
}
```

- [ ] **Step 4: Add the routes**

In `server/src/chats/routes.ts`, replace

```ts
import { deleteMessageForEveryone, reactToMessage } from '../messages/actions.js';
```

with

```ts
import { deleteMessageForEveryone, editMessage, listMessageEdits, reactToMessage } from '../messages/actions.js';
```

after

```ts
const reactionBody = z.object({ emoji: z.string().max(32) });
```

add

```ts
/** Spec §5: same limits as a text send. */
const editBody = z.object({ text: z.string().trim().min(1).max(4096) });
```

and after

```ts
    r.delete('/api/messages/:id', async (req) => deleteMessageForEveryone(ctx, req.user, idParams.parse(req.params).id));
```

add

```ts
    r.patch('/api/messages/:id', async (req) =>
      editMessage(ctx, req.user, idParams.parse(req.params).id, editBody.parse(req.body).text),
    );

    r.get('/api/messages/:id/edits', async (req) => listMessageEdits(ctx, req.user, idParams.parse(req.params).id));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/messages/actions.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/messages/actions.ts server/src/chats/routes.ts server/test/messages/actions.test.ts
git commit -m "feat(server): edit sent messages within 15 min with a version history" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Stickers (recent list, send by id, image as sticker)

**Files:**
- Modify: `server/src/messages/media.ts` (`saveMedia` at lines 46-59)
- Modify: `server/src/messages/ingest.ts` (`fetchMedia` patch at line 259)
- Modify: `server/src/messages/send.ts`:
  - imports at lines 1-17, `SendInput`, `OutKind` at line 21;
  - new constants and `reusableMessage`;
  - `callGateway` gets a sticker branch;
  - the whole `sendAgentMessage` is replaced.
- Modify: `server/src/messages/actions.ts` (import block; `listRecentStickers` at the end)
- Modify: `server/src/chats/routes.ts` (`multipartFields`, `readMultipart`, a JSON sticker body, the send route, `GET /api/stickers/recent`)
- Modify: `server/test/messages/actions-seed.ts` (adds `multipart`)
- Test: `server/test/messages/stickers.test.ts` (create), `server/test/messages/media.test.ts`, `server/test/messages/ingest.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `STICKER_MAX_BYTES`, `RECENT_STICKERS_LIMIT`, `forwardBlock`, `RecentStickerDto`.
  - Task 2: `messages.mediaSha256`.
  - Task 3: `ctx.wa.sendSticker`.
  - Task 5: the test seed.
  - Existing: `visibleChatsWhere`, `applyBotRunningBehavior`.
- Produces:
  - `saveMedia` returns `{ path, size, sha256 }`;
  - `SendInput.asSticker?: boolean` and `SendInput.stickerFromMessageId?: string`;
  - `MEDIA_NOT_FORWARDABLE`;
  - `reusableMessage(ctx, user, messageId): Promise<{ msg: MessageRow; chat: ChatRow }>`, which Task 8 uses;
  - `listRecentStickers(ctx, user)`;
  - `GET /api/stickers/recent`;
  - `POST /api/chats/:id/messages`, which also accepts a JSON `{ stickerFromMessageId, replyToId?, botAction? }` and the multipart field `asSticker=true`;
  - test seed `multipart(fields, file?)`.

- [ ] **Step 1: Write the failing tests**

In `server/test/messages/actions-seed.ts`, append:

```ts
/** A multipart/form-data body for app.inject: fields first, then the file (as @fastify/multipart expects). */
export function multipart(fields: Record<string, string>, file?: { name: string; mime: string; data: Buffer }) {
  const boundary = '----talktestboundary';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
```

Create `server/test/messages/stickers.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import {
  PHONE, minutesAgo, multipart, seedFile, seedMsg, seedWaitingRun, setupActions, type ActionsWorld,
} from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 fake-sticker');
const recent = (headers = w.headers) => w.app.inject({ method: 'GET', url: '/api/stickers/recent', headers });
const sendJson = (payload: object) => w.app.inject({ method: 'POST', url: `/api/chats/${w.chatId}/messages`, headers: w.headers, payload });
const stickersSent = () => w.ctx.wa.sent.filter((s) => s.method === 'sendSticker');

/** An inbound sticker with a saved file; `sha256` null = a row from before this delivery. */
const sticker = (sha256: string | null, minutes: number, extra: Partial<typeof messages.$inferInsert> = {}) =>
  seedMsg(w, {
    direction: 'in', authorId: null, kind: 'sticker', body: null, mediaMime: 'image/webp',
    mediaPath: `2026/10/${sha256 ?? 'old'}-${minutes}.webp`, mediaSha256: sha256, sentAt: minutesAgo(minutes), ...extra,
  });

describe('GET /api/stickers/recent', () => {
  it('lists the newest stickers of visible chats with a file, one per content, skipping deleted ones', async () => {
    const newest = await sticker('aaa', 1);
    await sticker('aaa', 2); // same file content, older
    const other = await sticker('bbb', 3);
    await sticker('ccc', 4, { deletedAt: new Date(), deletedSource: 'contact' });
    await seedMsg(w, { direction: 'in', authorId: null, kind: 'sticker', body: null, mediaPath: null, sentAt: minutesAgo(5) });
    const legacy = await sticker(null, 6); // no hash: deduped by file path only
    const hidden = await seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5565911112222' });
    await sticker('ddd', 0, { chatId: hidden.chatId });

    const res = await recent();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([newest, other, legacy].map((id) => ({ messageId: id, url: `/api/media/${id}` })));
  });

  it('stops at 40', async () => {
    for (let i = 0; i < 45; i += 1) await sticker(`hash-${i}`, i + 1);
    const list = (await recent()).json() as Array<{ messageId: string }>;
    expect(list).toHaveLength(40);
  });
});

describe('sending stickers', () => {
  it('sends a recent sticker by id, reusing its stored file', async () => {
    const path = await seedFile(w, '2026/10/fig.webp', WEBP);
    const src = await sticker('h1', 3, { mediaPath: path });

    const res = await sendJson({ stickerFromMessageId: src });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ direction: 'out', kind: 'sticker', body: null, authorId: w.s.agentA.id, status: 'sent' });
    const [row] = await w.ctx.db.select().from(messages).where(eq(messages.id, res.json().id));
    expect(row).toMatchObject({ mediaPath: path, mediaMime: 'image/webp', mediaSha256: 'h1', forwardedFromId: null });
    expect(stickersSent()).toMatchObject([{ phone: PHONE, payload: { base64: WEBP.toString('base64') } }]);
  });

  it('sends an uploaded PNG as a sticker; refuses big or non-image files', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\nfake');
    const body = multipart({ asSticker: 'true', signature: 'true', text: 'ignorado' }, { name: 'fig.png', mime: 'image/png', data: png });
    const res = await w.app.inject({
      method: 'POST', url: `/api/chats/${w.chatId}/messages`, headers: { ...w.headers, 'content-type': body.contentType }, payload: body.payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'sticker', body: null });
    expect(stickersSent()).toMatchObject([{ payload: { base64: png.toString('base64') } }]);
    expect(w.ctx.wa.sent.filter((s) => s.method === 'sendMedia')).toEqual([]);

    for (const file of [
      { name: 'grande.png', mime: 'image/png', data: Buffer.alloc(1024 * 1024 + 1) },
      { name: 'anim.gif', mime: 'image/gif', data: Buffer.from('GIF89a') },
    ]) {
      const bad = multipart({ asSticker: 'true' }, file);
      const refused = await w.app.inject({
        method: 'POST', url: `/api/chats/${w.chatId}/messages`, headers: { ...w.headers, 'content-type': bad.contentType }, payload: bad.payload,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: 'Envie uma imagem PNG, JPEG ou WebP de até 1 MB' });
    }
  });

  it('refuses a sticker from a chat the user cannot see (Review Focus 5) and a message that is not a sticker', async () => {
    const hidden = await seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5565911112222' });
    const hiddenSticker = await sticker('h2', 1, { chatId: hidden.chatId });
    expect((await sendJson({ stickerFromMessageId: hiddenSticker })).statusCode).toBe(404);
    const text = await seedMsg(w);
    expect((await sendJson({ stickerFromMessageId: text })).json()).toEqual({ error: 'Figurinha não encontrada' });
    expect(stickersSent()).toEqual([]);
  });

  it('asks BOT_RUNNING like any agent send', async () => {
    const path = await seedFile(w, '2026/10/fig2.webp', WEBP);
    const src = await sticker('h3', 1, { mediaPath: path });
    await seedWaitingRun(w);
    const asked = await sendJson({ stickerFromMessageId: src });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().code).toBe('BOT_RUNNING');
    expect((await sendJson({ stickerFromMessageId: src, botAction: 'keep' })).statusCode).toBe(200);
  });

  it('resends a failed sticker through sendSticker', async () => {
    const path = await seedFile(w, '2026/10/fig3.webp', WEBP);
    const src = await sticker('h4', 1, { mediaPath: path });
    w.ctx.wa.failNext();
    const failed = await sendJson({ stickerFromMessageId: src });
    expect(failed.json().status).toBe('failed');
    const resent = await w.app.inject({ method: 'POST', url: `/api/messages/${failed.json().id}/resend`, headers: w.headers });
    expect(resent.json()).toMatchObject({ kind: 'sticker', status: 'sent' });
    expect(stickersSent()).toHaveLength(1);
  });
});
```

In `server/test/messages/media.test.ts`, inside the first test of `describe('saveMedia', …)`, after

```ts
    expect(r.size).toBe(3);
```

add

```ts
    expect(r.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); // sha256('abc')
```

In `server/test/messages/ingest.test.ts`, append inside `describe('handleInbound: office reactions, deletes and edits', …)`:

```ts
  it('stores the content hash of a downloaded file (dedupes recent stickers)', async () => {
    await ingest(msg({ kind: 'sticker', body: null, hasMedia: true, mediaMime: 'image/webp' }));
    expect((await allMessages())[0]!.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/messages/stickers.test.ts test/messages/media.test.ts test/messages/ingest.test.ts`
Expected: FAIL:
- the recent list is a 404 (`Route GET:/api/stickers/recent not found`);
- the JSON sticker body is a 400 (`text` is required);
- `asSticker` is ignored and goes as `sendMedia`;
- `r.sha256` is `undefined`, and so is `mediaSha256` (`null`).

- [ ] **Step 3: Hash stored media**

In `server/src/messages/media.ts`, replace

```ts
import { randomUUID } from 'node:crypto';
```

with

```ts
import { createHash, randomUUID } from 'node:crypto';
```

and in `saveMedia` replace

```ts
): Promise<{ path: string; size: number }> {
```

with

```ts
): Promise<{ path: string; size: number; sha256: string }> {
```

and

```ts
  return { path, size: data.length };
```

with

```ts
  return { path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
```

In `server/src/messages/ingest.ts` (`fetchMedia`), replace

```ts
    patch = { mediaPath: saved.path, mediaSize: saved.size, mediaMime: media.mime, mediaName: name };
```

with

```ts
    patch = { mediaPath: saved.path, mediaSize: saved.size, mediaMime: media.mime, mediaName: name, mediaSha256: saved.sha256 };
```

- [ ] **Step 4: Send stickers**

In `server/src/messages/send.ts`, replace

```ts
import type { BotAction, BotAttachment } from '@talk/shared';
```

with

```ts
import { STICKER_MAX_BYTES, forwardBlock, type BotAction, type BotAttachment } from '@talk/shared';
```

replace

```ts
type OutKind = 'text' | 'image' | 'video' | 'audio' | 'document';
```

with

```ts
type OutKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker';
```

replace

```ts
export interface SendInput {
  text?: string;
  file?: { buffer: Buffer; mime: string; name: string };
  asVoice?: boolean;
```

with

```ts
export interface SendInput {
  text?: string;
  file?: { buffer: Buffer; mime: string; name: string };
  asVoice?: boolean;
  /** Spec §6: the file goes as a WhatsApp sticker (PNG/JPEG/WebP up to 1 MB; Evolution converts it to WebP). */
  asSticker?: boolean;
  /** Spec §6: send a recent sticker again; its stored file is reused, nothing is uploaded. */
  stickerFromMessageId?: string;
```

After the `waAddress` function, add:

```ts
const STICKER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const STICKER_INVALID = 'Envie uma imagem PNG, JPEG ou WebP de até 1 MB';
export const MEDIA_NOT_FORWARDABLE = 'Esta mídia não está disponível para encaminhar';

/**
 * A stored message whose content a send reuses (a recent sticker; a forward, Task 8). canSee on its chat (404); notes,
 * unsupported and deleted messages are refused; media must still have its file (never downloaded → 400).
 */
export async function reusableMessage(ctx: AppCtx, user: AuthUser, messageId: string): Promise<{ msg: MessageRow; chat: ChatRow }> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  const chat = await getChatForUser(ctx, user, msg.chatId);
  const blocked = forwardBlock({ ...msg, deleted: msg.deletedAt });
  if (blocked) throw badRequest(blocked.reason);
  if (msg.kind !== 'text' && !msg.mediaPath) throw badRequest(MEDIA_NOT_FORWARDABLE);
  return { msg, chat };
}
```

In `callGateway`, replace

```ts
  if (msg.kind === 'audio') return ctx.wa.sendAudio(instance, to, base64, quoted);
```

with

```ts
  if (msg.kind === 'sticker') return ctx.wa.sendSticker(instance, to, base64, quoted);
  if (msg.kind === 'audio') return ctx.wa.sendAudio(instance, to, base64, quoted);
```

Replace the whole `sendAgentMessage` function (from `export async function sendAgentMessage(` to its closing `}` before `resendMessage`) with:

```ts
export async function sendAgentMessage(ctx: AppCtx, user: AuthUser, chatId: string, input: SendInput): Promise<MessageDto> {
  const chat = await getChatForUser(ctx, user, chatId); // 404 also covers private chats of someone else
  if (chat.state !== 'open') throw conflict('Conversa finalizada');

  const file = input.file ?? null;
  const asVoice = !!input.asVoice && file !== null;
  const asSticker = !!input.asSticker && file !== null;
  if (file && asVoice && !baseMime(file.mime).startsWith('audio/')) throw badRequest('Áudio inválido');
  if (file && asSticker && (!STICKER_MIMES.has(baseMime(file.mime)) || file.buffer.length > STICKER_MAX_BYTES)) {
    throw badRequest(STICKER_INVALID);
  }
  const sticker = input.stickerFromMessageId ? (await reusableMessage(ctx, user, input.stickerFromMessageId)).msg : null;
  if (sticker && sticker.kind !== 'sticker') throw badRequest('Figurinha não encontrada');
  // Reused content (spec §6): the source's stored file and text are sent as they are, unsigned.
  const source = sticker;
  const text = asVoice || asSticker || source ? null : input.text?.trim() || null;
  if (!text && !file && !source) throw badRequest('Mensagem vazia');

  let replyToId: string | null = null;
  if (input.replyToId) {
    const [orig] = await ctx.db
      .select({ id: messages.id, deletedAt: messages.deletedAt })
      .from(messages)
      .where(and(eq(messages.id, input.replyToId), eq(messages.chatId, chatId)));
    if (!orig) throw badRequest('Mensagem citada não encontrada');
    if (orig.deletedAt) throw badRequest('Mensagem apagada não pode ser citada'); // spec §4
    replyToId = orig.id;
  }

  // Spec §5.5, after input validation and before anything is saved or sent: 'ask' → 409 BOT_RUNNING, 'stop' stops the bots.
  await applyBotRunningBehavior(ctx, user, chatId, input.botAction, 'agent_message');

  let body = source ? source.body : text;
  if (text && input.signature) {
    const [sector] = await ctx.db.select({ name: sectors.name }).from(sectors).where(eq(sectors.id, chat.sectorId));
    body = formatSignature(text, signatureLabel(user, sector?.name ?? ''));
  }

  const kind: OutKind = source ? (source.kind as OutKind) : asSticker ? 'sticker' : file ? fileKind(file.mime, asVoice) : 'text';
  const saved = file ? await saveMedia(ctx.config.mediaDir, file.buffer, file.mime, file.name) : null;
  // ponytail: a reused file is shared by both rows (nothing deletes media files today); copy it if files ever get pruned.
  const media = source
    ? { path: source.mediaPath, mime: source.mediaMime, size: source.mediaSize, name: source.mediaName, sha256: source.mediaSha256 }
    : { path: saved?.path ?? null, mime: file?.mime ?? null, size: saved?.size ?? null, name: file?.name ?? null, sha256: saved?.sha256 ?? null };
  const now = new Date();

  const row = await ctx.db.transaction(async (tx) => {
    await touchChat(tx, user, chat, { at: now, preview: messagePreview(kind, source ? source.body : text) });
    const [inserted] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        chatId,
        channelId: chat.channelId,
        direction: 'out',
        kind,
        body,
        mediaPath: media.path,
        mediaMime: media.mime,
        mediaSize: media.size,
        mediaName: media.name,
        mediaSha256: media.sha256,
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
```

- [ ] **Step 5: List the recent stickers**

In `server/src/messages/actions.ts`, replace

```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  DELETED_REASON, deleteBlock, editBlock, isSingleEmoji, reactBlock, type ActionBlock, type MessageDto, type MessageEditDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { messageEdits, messages, users } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import type { AuthUser } from '../inbox/visibility.js';
```

with

```ts
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  DELETED_REASON, RECENT_STICKERS_LIMIT, deleteBlock, editBlock, isSingleEmoji, reactBlock,
  type ActionBlock, type MessageDto, type MessageEditDto, type RecentStickerDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, messageEdits, messages, users } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { visibleChatsWhere, type AuthUser } from '../inbox/visibility.js';
```

and append at the end of the file:

```ts
/**
 * Spec §6: the newest stickers, received or sent, in the chats this user can see, with a saved file, one per file
 * content. Rows from before media_sha256 existed dedupe by file path only.
 */
export async function listRecentStickers(ctx: AppCtx, user: AuthUser): Promise<RecentStickerDto[]> {
  // ponytail: scans the newest 400 sticker rows and dedupes in memory; enough for one office, use DISTINCT ON if it grows.
  const rows = await ctx.db
    .select({ id: messages.id, sha256: messages.mediaSha256, path: messages.mediaPath })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(and(eq(messages.kind, 'sticker'), isNotNull(messages.mediaPath), isNull(messages.deletedAt), visibleChatsWhere(user)))
    .orderBy(desc(messages.sentAt), desc(messages.createdAt))
    .limit(400);
  const seen = new Set<string>();
  const out: RecentStickerDto[] = [];
  for (const r of rows) {
    const key = r.sha256 ?? `path:${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ messageId: r.id, url: `/api/media/${r.id}` });
    if (out.length === RECENT_STICKERS_LIMIT) break;
  }
  return out;
}
```

- [ ] **Step 6: Accept the sticker inputs in the routes**

In `server/src/chats/routes.ts`, replace

```ts
import { deleteMessageForEveryone, editMessage, listMessageEdits, reactToMessage } from '../messages/actions.js';
```

with

```ts
import { deleteMessageForEveryone, editMessage, listMessageEdits, listRecentStickers, reactToMessage } from '../messages/actions.js';
```

replace

```ts
const multipartFields = z.object({
  text: z.string().trim().max(4096).optional(),
  signature: z.stringbool().default(true),
  asVoice: z.stringbool().default(false),
```

with

```ts
/** Spec §6: a recent sticker, sent again by the id of the message that carries it. */
const stickerBody = z.object({ stickerFromMessageId: z.uuid(), replyToId: z.uuid().optional(), botAction: botActionField });
const multipartFields = z.object({
  text: z.string().trim().max(4096).optional(),
  signature: z.stringbool().default(true),
  asVoice: z.stringbool().default(false),
  asSticker: z.stringbool().default(false),
```

replace

```ts
  return {
    file, text: f.text || undefined, signature: f.signature, asVoice: f.asVoice, replyToId: f.replyToId, botAction: f.botAction,
  };
}
```

with

```ts
  return {
    file, text: f.text || undefined, signature: f.signature, asVoice: f.asVoice, asSticker: f.asSticker, replyToId: f.replyToId,
    botAction: f.botAction,
  };
}

/** JSON send: a recent sticker (`stickerFromMessageId`) or a text. */
function jsonSendInput(body: unknown): SendInput {
  if (body && typeof body === 'object' && 'stickerFromMessageId' in body) return { ...stickerBody.parse(body), signature: false };
  return textBody.parse(body);
}
```

replace

```ts
      const input: SendInput = req.isMultipart() ? await readMultipart(req) : textBody.parse(req.body);
```

with

```ts
      const input: SendInput = req.isMultipart() ? await readMultipart(req) : jsonSendInput(req.body);
```

and after

```ts
    r.get('/api/messages/:id/edits', async (req) => listMessageEdits(ctx, req.user, idParams.parse(req.params).id));
```

add

```ts
    r.get('/api/stickers/recent', async (req) => listRecentStickers(ctx, req.user));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/messages/stickers.test.ts test/messages/media.test.ts test/messages/ingest.test.ts test/messages/send.test.ts test/chats/actions.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/messages/media.ts server/src/messages/ingest.ts server/src/messages/send.ts server/src/messages/actions.ts server/src/chats/routes.ts server/test/messages/actions-seed.ts server/test/messages/stickers.test.ts server/test/messages/media.test.ts server/test/messages/ingest.test.ts
git commit -m "feat(server): recent stickers and sticker sends by id or uploaded image" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Forward (API)

**Files:**
- Modify: `server/src/inbox/chats.ts` (`startChat` at lines 297-320)
- Modify: `server/src/messages/send.ts` (`SendInput`; the `source` line and the insert in `sendAgentMessage`)
- Modify: `server/src/messages/actions.ts` (imports; `ForwardTarget`, `forwardMessage` at the end)
- Modify: `server/src/chats/routes.ts` (the actions import, a forward body, the route)
- Test: `server/test/messages/forward.test.ts` (create)

**Interfaces:**
- Consumes:
  - Task 7: `reusableMessage`, `MEDIA_NOT_FORWARDABLE`, and the source path of `sendAgentMessage`.
  - Task 5: the test seed (`setupActions`, `seedMsg`, `seedFile`, `seedWaitingRun`).
  - Existing: `startChat`, `BotAction`.
- Produces:
  - `startChat` input gains `channelId?: string`, answering 400 `'Canal inválido.'` for an unknown channel;
  - `SendInput.forwardFromId?: string`;
  - `ForwardTarget` and `forwardMessage(ctx, user, messageId, to)`;
  - `POST /api/messages/:id/forward`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/messages/forward.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, contacts, messages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { seedFile, seedMsg, seedWaitingRun, setupActions, type ActionsWorld } from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const forward = (id: string, payload: object) =>
  w.app.inject({ method: 'POST', url: `/api/messages/${id}/forward`, headers: w.headers, payload });
const sentBy = (method: string) => w.ctx.wa.sent.filter((s) => s.method === method);
const otherOpenChat = () =>
  seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorA, ownerId: w.s.agentA.id, phone: '5565988887777', name: 'Outro' });
const newContact = async () =>
  (await w.ctx.db.insert(contacts).values({ name: 'Novo', phone: '5565977776666' }).returning())[0]!;

describe('POST /api/messages/:id/forward', () => {
  it('forwards a text to another open chat, unsigned and marked as forwarded', async () => {
    const src = await seedMsg(w, { direction: 'in', authorId: null, body: 'Meu CPF é 123' });
    const dest = await otherOpenChat();

    const res = await forward(src, { chatId: dest.chatId });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      chatId: dest.chatId, direction: 'out', kind: 'text', body: 'Meu CPF é 123', forwarded: true, authorId: w.s.agentA.id,
    });
    const [row] = await w.ctx.db.select().from(messages).where(eq(messages.id, res.json().id));
    expect(row!.forwardedFromId).toBe(src);
    expect(sentBy('sendText')).toMatchObject([{ phone: '5565988887777', payload: { text: 'Meu CPF é 123' } }]);
  });

  it('forwards a photo with its caption to a contact without an open chat, opening one', async () => {
    const path = await seedFile(w, '2026/10/foto.jpg', Buffer.from('jpeg-bytes'));
    const src = await seedMsg(w, {
      direction: 'in', authorId: null, kind: 'image', body: 'Comprovante', mediaPath: path, mediaMime: 'image/jpeg', mediaSize: 10,
    });
    const contact = await newContact();

    const res = await forward(src, { contactId: contact.id });

    expect(res.statusCode).toBe(200);
    const [chat] = await w.ctx.db.select().from(chats).where(eq(chats.contactId, contact.id));
    expect(chat).toMatchObject({ state: 'open', ownerId: w.s.agentA.id, channelId: w.s.channelId });
    expect(res.json()).toMatchObject({ chatId: chat!.id, kind: 'image', body: 'Comprovante', forwarded: true });
    expect(sentBy('sendMedia')).toMatchObject([
      {
        phone: '5565977776666',
        payload: { media: { kind: 'image', base64: Buffer.from('jpeg-bytes').toString('base64'), mime: 'image/jpeg', caption: 'Comprovante' } },
      },
    ]);
  });

  it('forwards a sticker as a sticker', async () => {
    const path = await seedFile(w, '2026/10/fig.webp', Buffer.from('RIFFwebp'));
    const src = await seedMsg(w, { direction: 'in', authorId: null, kind: 'sticker', body: null, mediaPath: path, mediaMime: 'image/webp' });
    const dest = await otherOpenChat();
    expect((await forward(src, { chatId: dest.chatId })).json()).toMatchObject({ kind: 'sticker', forwarded: true });
    expect(sentBy('sendSticker')).toHaveLength(1);
  });

  it('refuses media that was never downloaded and opens no chat', async () => {
    const src = await seedMsg(w, { direction: 'in', authorId: null, kind: 'video', body: null, mediaPath: null, error: 'mídia indisponível' });
    const contact = await newContact();

    const res = await forward(src, { contactId: contact.id });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Esta mídia não está disponível para encaminhar' });
    expect(await w.ctx.db.select().from(chats).where(eq(chats.contactId, contact.id))).toEqual([]);
  });

  it('never forwards notes or deleted messages', async () => {
    const dest = await otherOpenChat();
    const note = await seedMsg(w, { kind: 'note', externalId: null });
    expect((await forward(note, { chatId: dest.chatId })).json()).toEqual({ error: 'Esta mensagem não pode ser encaminhada' });
    const gone = await seedMsg(w, { deletedAt: new Date(), deletedSource: 'contact', direction: 'in', authorId: null });
    expect((await forward(gone, { chatId: dest.chatId })).json()).toEqual({ error: 'Mensagem apagada' });
  });

  it('asks BOT_RUNNING when the destination has a running chatbot', async () => {
    const src = await seedMsg(w);
    const dest = await otherOpenChat();
    await seedWaitingRun(w, dest.chatId, dest.contactId);

    const asked = await forward(src, { chatId: dest.chatId });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().code).toBe('BOT_RUNNING');
    expect((await forward(src, { chatId: dest.chatId, botAction: 'keep' })).statusCode).toBe(200);
  });

  it('needs canSee on both ends (Review Focus 5)', async () => {
    const hidden = await seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5565966665555' });
    const src = await seedMsg(w);
    expect((await forward(src, { chatId: hidden.chatId })).statusCode).toBe(404);
    const hiddenSrc = await seedMsg(w, { chatId: hidden.chatId, direction: 'in', authorId: null });
    const dest = await otherOpenChat();
    expect((await forward(hiddenSrc, { chatId: dest.chatId })).statusCode).toBe(404);
    expect(sentBy('sendText')).toEqual([]);
  });

  it('refuses a closed destination and a message from a closed chat', async () => {
    const closedDest = await seedChat(w.ctx, {
      channelId: w.s.channelId, sectorId: w.s.sectorA, ownerId: w.s.agentA.id, phone: '5565955554444', state: 'closed',
    });
    const src = await seedMsg(w);
    expect((await forward(src, { chatId: closedDest.chatId })).json()).toEqual({ error: 'Conversa finalizada' });

    const dest = await otherOpenChat();
    await w.ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, w.chatId));
    expect((await forward(src, { chatId: dest.chatId })).json()).toEqual({ error: 'Conversa finalizada' });
  });

  it('rejects a body with neither chatId nor contactId', async () => {
    const src = await seedMsg(w);
    expect((await forward(src, {})).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/messages/forward.test.ts`
Expected: FAIL with 404 `Route POST:/api/messages/…/forward not found`.

- [ ] **Step 3: Let `startChat` take the channel**

In `server/src/inbox/chats.ts`, replace

```ts
  input: { contactId?: string; phone?: string; name?: string; sectorId?: string },
): Promise<ChatRow> {
  if (input.sectorId !== undefined && !(await sectorExists(ctx.db, input.sectorId))) throw badRequest('Setor inválido.');
  const sectorId = input.sectorId ?? (await getDefaultSectorId(ctx.db));
  // ponytail: one WhatsApp number today; take the oldest channel. Add channelId to the input when a second number exists.
  const [channel] = await ctx.db.select({ id: channels.id }).from(channels).orderBy(asc(channels.createdAt)).limit(1);
  if (!channel) throw conflict('Nenhum canal de WhatsApp cadastrado.');
```

with

```ts
  input: { contactId?: string; phone?: string; name?: string; sectorId?: string; channelId?: string },
): Promise<ChatRow> {
  if (input.sectorId !== undefined && !(await sectorExists(ctx.db, input.sectorId))) throw badRequest('Setor inválido.');
  const sectorId = input.sectorId ?? (await getDefaultSectorId(ctx.db));
  // channelId: a forward keeps the source message's number. Otherwise the oldest channel (one WhatsApp number today).
  const [channel] = input.channelId
    ? UUID_RE.test(input.channelId)
      ? await ctx.db.select({ id: channels.id }).from(channels).where(eq(channels.id, input.channelId))
      : []
    : await ctx.db.select({ id: channels.id }).from(channels).orderBy(asc(channels.createdAt)).limit(1);
  if (!channel) throw input.channelId ? badRequest('Canal inválido.') : conflict('Nenhum canal de WhatsApp cadastrado.');
```

- [ ] **Step 4: Forward through the normal send**

In `server/src/messages/send.ts`, replace

```ts
  /** Spec §6: send a recent sticker again; its stored file is reused, nothing is uploaded. */
  stickerFromMessageId?: string;
```

with

```ts
  /** Spec §6: send a recent sticker again; its stored file is reused, nothing is uploaded. */
  stickerFromMessageId?: string;
  /** Spec §7: forward — the content of this stored message (text or saved file) goes as a new message. */
  forwardFromId?: string;
```

In `sendAgentMessage`, replace

```ts
  // Reused content (spec §6): the source's stored file and text are sent as they are, unsigned.
  const source = sticker;
```

with

```ts
  const forwarded = input.forwardFromId ? (await reusableMessage(ctx, user, input.forwardFromId)).msg : null;
  // Reused content (spec §6, §7): the source's stored file and text are sent as they are, unsigned.
  const source = sticker ?? forwarded;
```

and in the insert, replace

```ts
        mediaSha256: media.sha256,
        authorId: user.id,
```

with

```ts
        mediaSha256: media.sha256,
        forwardedFromId: forwarded?.id ?? null,
        authorId: user.id,
```

In `server/src/messages/actions.ts`, replace

```ts
import {
  DELETED_REASON, RECENT_STICKERS_LIMIT, deleteBlock, editBlock, isSingleEmoji, reactBlock,
  type ActionBlock, type MessageDto, type MessageEditDto, type RecentStickerDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, messageEdits, messages, users } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
```

with

```ts
import {
  DELETED_REASON, RECENT_STICKERS_LIMIT, deleteBlock, editBlock, isSingleEmoji, reactBlock,
  type ActionBlock, type BotAction, type MessageDto, type MessageEditDto, type RecentStickerDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, messageEdits, messages, users } from '../db/schema.js';
import { getChatForUser, startChat, type ChatRow } from '../inbox/chats.js';
```

replace

```ts
import { gatewayTarget } from './send.js';
```

with

```ts
import { gatewayTarget, reusableMessage, sendAgentMessage } from './send.js';
```

and append at the end of the file:

```ts
export type ForwardTarget =
  | { chatId: string; botAction?: BotAction }
  | { contactId: string; channelId?: string; botAction?: BotAction };

/**
 * Spec §7: the content of a stored message goes to one destination through its normal send path (canSee, open chat,
 * BOT_RUNNING), unsigned, with forwarded_from_id set. A contact without an open chat gets one, like "Nova conversa".
 * The source is checked first, so a refused forward never opens a chat. The contact's phone shows no "Encaminhada"
 * mark: Evolution 2.3.7 has no forward endpoint.
 */
export async function forwardMessage(ctx: AppCtx, user: AuthUser, messageId: string, to: ForwardTarget): Promise<MessageDto> {
  const { msg, chat } = await reusableMessage(ctx, user, messageId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada'); // spec §2: no action from a closed chat
  const chatId =
    'chatId' in to
      ? to.chatId
      : (await startChat(ctx, user, { contactId: to.contactId, channelId: to.channelId ?? msg.channelId })).id;
  return sendAgentMessage(ctx, user, chatId, { forwardFromId: msg.id, signature: false, botAction: to.botAction });
}
```

- [ ] **Step 5: Add the route**

In `server/src/chats/routes.ts`, replace

```ts
import { deleteMessageForEveryone, editMessage, listMessageEdits, listRecentStickers, reactToMessage } from '../messages/actions.js';
```

with

```ts
import {
  deleteMessageForEveryone, editMessage, forwardMessage, listMessageEdits, listRecentStickers, reactToMessage,
} from '../messages/actions.js';
```

after

```ts
const editBody = z.object({ text: z.string().trim().min(1).max(4096) });
```

add

```ts
/** Spec §7: one destination: an open chat, or a contact (+ optional channel; default = the source message's channel). */
const forwardBody = z.union([
  z.object({ chatId: z.uuid(), botAction: botActionField }),
  z.object({ contactId: z.uuid(), channelId: z.uuid().optional(), botAction: botActionField }),
]);
```

and after

```ts
    r.get('/api/stickers/recent', async (req) => listRecentStickers(ctx, req.user));
```

add

```ts
    r.post('/api/messages/:id/forward', async (req) =>
      forwardMessage(ctx, req.user, idParams.parse(req.params).id, forwardBody.parse(req.body)),
    );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/messages/forward.test.ts test/inbox/chats-start.test.ts test/messages/stickers.test.ts`
Expected: PASS.

Run: `npm test -w server` and `npm run typecheck -w server`
Expected: every server test passes; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/inbox/chats.ts server/src/messages/send.ts server/src/messages/actions.ts server/src/chats/routes.ts server/test/messages/forward.test.ts
git commit -m "feat(server): forward messages to an open chat or a contact" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Web API client, bubble tags, both reactions and the version history

**Files:**
- Modify: `web/src/lib/api.ts`:
  - type imports at lines 2-31;
  - input types after `SendFileInput` at lines 72-74;
  - `chats.sendFile` and the new `chats.sendSticker`;
  - `messages`;
  - a new `stickers` group;
  - `qk`.
- Create: `web/src/components/conversation/MessageDialogs.tsx`
- Modify: `web/src/components/conversation/MessageBubble.tsx` (imports at lines 1-8; tags, reactions and the history dialog in `MessageBubble`, lines 76-171)
- Test: `web/src/lib/api.test.ts` (new `it` at the end of the last `describe`), `web/src/components/conversation/MessageBubble.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1: `MessageDto.officeReaction/deleted/edited/forwarded`, `MessageEditDto`, `RecentStickerDto`, `deletedTag`, `editedTag`.
  - Task 5-8 routes (see the HTTP table).
  - Existing: `Modal` (`ChatDialogs.tsx`).
- Produces:
  - `api.messages.react/remove/edit/edits/forward`, `api.chats.sendSticker`, `api.stickers.recent`;
  - the types `SendStickerInput` and `ForwardInput`, and `SendFileInput.asSticker`;
  - the query keys `qk.messageEdits(id)` and `qk.recentStickers`;
  - `EditHistoryDialog({ messageId, onClose })`;
  - bubble markup the next tasks keep:
    - tags `[data-tag="forwarded"]`, `[data-tag="deleted"]` and `button[data-tag="edited"]`;
    - reactions with aria-label `Reação do contato <e>` and `Reação do escritório <e>`.

- [ ] **Step 1: Write the failing API test**

In `web/src/lib/api.test.ts`, add after the test `'calls the bot routes with the right method, path and body'` (inside the same `describe`):

```ts
  it('calls the message action routes with the right method, path and body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await api.messages.react('m1', '👍');
    await api.messages.remove('m1');
    await api.messages.edit('m1', 'novo');
    await api.messages.edits('m1');
    await api.messages.forward('m1', { contactId: 'k1' });
    await api.chats.sendSticker('c1', { stickerFromMessageId: 'm2' });
    await api.stickers.recent();
    await api.chats.sendFile('c1', { file: new File(['png'], 'f.png', { type: 'image/png' }), signature: false, asSticker: true });
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`)).toEqual([
      'POST /api/messages/m1/reaction',
      'DELETE /api/messages/m1',
      'PATCH /api/messages/m1',
      'GET /api/messages/m1/edits',
      'POST /api/messages/m1/forward',
      'POST /api/chats/c1/messages',
      'GET /api/stickers/recent',
      'POST /api/chats/c1/messages',
    ]);
    expect(fetchMock.mock.calls[0]![1]?.body).toBe('{"emoji":"👍"}');
    expect(fetchMock.mock.calls[1]![1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[2]![1]?.body).toBe('{"text":"novo"}');
    expect(fetchMock.mock.calls[4]![1]?.body).toBe('{"contactId":"k1"}');
    expect(fetchMock.mock.calls[5]![1]?.body).toBe('{"stickerFromMessageId":"m2"}');
    expect([...(fetchMock.mock.calls[7]![1]?.body as FormData).keys()]).toEqual(['signature', 'asSticker', 'file']);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w web -- src/lib/api.test.ts`
Expected: FAIL with `api.messages.react is not a function`.

- [ ] **Step 3: Add the client calls**

In `web/src/lib/api.ts`, replace

```ts
  ManualBotDto,
  Me,
  MessageDto,
```

with

```ts
  ManualBotDto,
  Me,
  MessageDto,
  MessageEditDto,
```

and

```ts
  QuickAnswerDto,
  SaveVersionInput,
```

with

```ts
  QuickAnswerDto,
  RecentStickerDto,
  SaveVersionInput,
```

Replace

```ts
export interface SendFileInput {
  file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean; botAction?: BotAction;
}
```

with

```ts
export interface SendFileInput {
  file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean; botAction?: BotAction;
  /** Spec §6: send the image as a WhatsApp sticker. */
  asSticker?: boolean;
}
/** Spec §6: a recent sticker, sent again by the id of the message that carries it. */
export interface SendStickerInput { stickerFromMessageId: string; replyToId?: string; botAction?: BotAction }
/** Spec §7: one destination per forward. */
export type ForwardInput = ({ chatId: string } | { contactId: string; channelId?: string }) & { botAction?: BotAction };
```

In `chats.sendFile`, replace

```ts
      if (input.asVoice) form.append('asVoice', 'true');
```

with

```ts
      if (input.asVoice) form.append('asVoice', 'true');
      if (input.asSticker) form.append('asSticker', 'true');
```

replace

```ts
    addNote: (id: string, text: string) => request<MessageDto>('POST', `/api/chats/${enc(id)}/notes`, { text }),
  },
  messages: {
    resend: (messageId: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/resend`),
    mediaUrl: (messageId: string) => `/api/media/${enc(messageId)}`,
  },
```

with

```ts
    addNote: (id: string, text: string) => request<MessageDto>('POST', `/api/chats/${enc(id)}/notes`, { text }),
    sendSticker: (id: string, input: SendStickerInput) => request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, input),
  },
  messages: {
    resend: (messageId: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/resend`),
    mediaUrl: (messageId: string) => `/api/media/${enc(messageId)}`,
    /** '' or the current emoji removes the office's reaction. */
    react: (messageId: string, emoji: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/reaction`, { emoji }),
    /** Delete for everyone. */
    remove: (messageId: string) => request<MessageDto>('DELETE', `/api/messages/${enc(messageId)}`),
    edit: (messageId: string, text: string) => request<MessageDto>('PATCH', `/api/messages/${enc(messageId)}`, { text }),
    edits: (messageId: string) => request<MessageEditDto[]>('GET', `/api/messages/${enc(messageId)}/edits`),
    /** Returns the new message, in the destination chat. */
    forward: (messageId: string, input: ForwardInput) =>
      request<MessageDto>('POST', `/api/messages/${enc(messageId)}/forward`, input),
  },
  stickers: {
    recent: () => request<RecentStickerDto[]>('GET', '/api/stickers/recent'),
  },
```

In `qk`, replace

```ts
  timeline: (id: string) => ['chats', 'timeline', id] as const,
```

with

```ts
  timeline: (id: string) => ['chats', 'timeline', id] as const,
  /** Under ['chats'] so the WS reconnect invalidation refreshes it too. */
  messageEdits: (messageId: string) => ['chats', 'edits', messageId] as const,
  recentStickers: ['chats', 'stickers'] as const,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w web -- src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing bubble tests**

In `web/src/components/conversation/MessageBubble.test.tsx`, replace

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
```

with

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
```

replace

```ts
afterEach(cleanup);
```

with

```ts
// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
```

and append at the end of the file:

```ts
describe('MessageBubble tags and reactions', () => {
  it('keeps a deleted message visible with who deleted it', () => {
    const c = renderBubble({ ...base, direction: 'in', authorId: null, deleted: { at: base.sentAt, source: 'contact', byName: null } });
    expect(c.textContent).toContain('Olá');
    expect(c.querySelector('[data-tag="deleted"]')?.textContent).toBe('Apagada pelo contato');
    const mine = renderBubble({ ...base, id: 'm2', deleted: { at: base.sentAt, source: 'office', byName: 'Ana Lima' } });
    expect(mine.querySelector('[data-tag="deleted"]')?.textContent).toBe('Apagada por Ana Lima');
  });

  it('shows Encaminhada and both reactions, the contact one and the office one', () => {
    const c = renderBubble({ ...base, forwarded: true, reaction: '👍', officeReaction: '❤️' });
    expect(c.querySelector('[data-tag="forwarded"]')?.textContent).toContain('Encaminhada');
    expect(screen.getByLabelText('Reação do contato 👍')).toBeTruthy();
    expect(screen.getByLabelText('Reação do escritório ❤️')).toBeTruthy();
    expect(renderBubble({ ...base, id: 'm3' }).querySelector('[data-tag]')).toBeNull();
  });

  it('opens the previous versions from the edited tag', async () => {
    stubFetch({
      'GET /api/messages/m1/edits': [
        { id: 'e1', previousBody: 'Olá!', source: 'office', editedByName: 'Ana Lima', newTextUnavailable: false, editedAt: '2026-10-15T12:01:00.000Z' },
      ],
    });
    renderBubble({ ...base, edited: { at: base.sentAt, source: 'contact', newTextUnavailable: true } });
    fireEvent.click(screen.getByRole('button', { name: 'editada pelo contato (novo texto indisponível)' }));
    expect(await screen.findByText('Olá!')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Versões anteriores' })).toBeTruthy();
    expect(calls).toEqual([{ method: 'GET', path: '/api/messages/m1/edits', body: undefined }]);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx`
Expected: FAIL. There is no `[data-tag]` and no `Reação do escritório` label, and the `editada …` button does not exist.

- [ ] **Step 7: Create the history dialog**

Create `web/src/components/conversation/MessageDialogs.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import type { MessageEditDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { Modal } from './ChatDialogs';

const SOURCE_LABEL: Record<MessageEditDto['source'], string> = { office: 'Atendente', contact: 'Contato', phone: 'Celular' };

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Spec §5: the text a message had before each edit, newest first. */
export function EditHistoryDialog({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const edits = useQuery({ queryKey: qk.messageEdits(messageId), queryFn: () => api.messages.edits(messageId) });
  return (
    <Modal title="Versões anteriores" onCancel={onClose}>
      {edits.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {edits.isError && (
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar as versões.
        </p>
      )}
      <ol className="max-h-80 space-y-2 overflow-y-auto">
        {edits.data?.map((e) => (
          <li key={e.id} className="rounded bg-surface px-3 py-2 text-sm">
            <p className="mb-1 text-xs text-muted">
              {when(e.editedAt)} · {e.editedByName ?? SOURCE_LABEL[e.source]}
              {e.newTextUnavailable ? ' · novo texto indisponível' : ''}
            </p>
            <p className="whitespace-pre-wrap break-words">{e.previousBody ?? '(sem texto)'}</p>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm hover:bg-surface">
          Fechar
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 8: Show the tags, both reactions and the history in the bubble**

In `web/src/components/conversation/MessageBubble.tsx`, replace

```ts
import { ArrowBendUpLeft, Check, Checks, Clock, FileText, ImageBroken, Robot, WarningCircle } from '@phosphor-icons/react';
```

with

```ts
import { ArrowBendUpLeft, Check, Checks, Clock, FileText, ImageBroken, Robot, ShareFat, WarningCircle } from '@phosphor-icons/react';
```

and

```ts
import { errorMessage, previewText, timeOfDay } from './model';
```

with

```ts
import { EditHistoryDialog } from './MessageDialogs';
import { deletedTag, editedTag, errorMessage, previewText, timeOfDay } from './model';

const chip = 'rounded-full border border-border bg-surface px-1.5 text-sm shadow-sm';
```

In `MessageBubble`, replace

```ts
  const [resendError, setResendError] = useState<string | null>(null);
```

with

```ts
  const [resendError, setResendError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
```

replace

```tsx
      <div className={`relative max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${tone} ${m.reaction ? 'mb-3' : ''}`}>
```

with

```tsx
      <div className={`relative max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${tone} ${m.reaction || m.officeReaction ? 'mb-3' : ''}`}>
```

replace

```tsx
        {m.replyTo && (
```

with

```tsx
        {m.forwarded && (
          <p data-tag="forwarded" className="mb-1 flex items-center gap-1 text-xs italic opacity-70">
            <ShareFat size={12} aria-hidden /> Encaminhada
          </p>
        )}
        {m.replyTo && (
```

replace

```tsx
        <div className="mt-1 flex items-center justify-end gap-1 text-xs opacity-70">
          <time dateTime={m.sentAt}>{timeOfDay(m.sentAt)}</time>
```

with

```tsx
        <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-xs opacity-70">
          {m.deleted && (
            <span data-tag="deleted" className="font-medium text-danger">
              {deletedTag(m.deleted)}
            </span>
          )}
          {m.edited && (
            <button
              type="button"
              data-tag="edited"
              title="Ver versões anteriores"
              onClick={() => setHistoryOpen(true)}
              className="hover:underline"
            >
              {editedTag(m.edited)}
            </button>
          )}
          <time dateTime={m.sentAt}>{timeOfDay(m.sentAt)}</time>
```

replace

```tsx
        {m.reaction && (
          <span
            aria-label={`Reação ${m.reaction}`}
            className={`absolute -bottom-3 ${right ? 'left-2' : 'right-2'} rounded-full border border-border bg-surface px-1.5 text-sm shadow-sm`}
          >
            {m.reaction}
          </span>
        )}
```

with

```tsx
        {(m.reaction || m.officeReaction) && (
          <span className={`absolute -bottom-3 ${right ? 'left-2' : 'right-2'} flex gap-0.5`}>
            {m.reaction && (
              <span aria-label={`Reação do contato ${m.reaction}`} className={chip}>
                {m.reaction}
              </span>
            )}
            {m.officeReaction && (
              <span aria-label={`Reação do escritório ${m.officeReaction}`} className={chip}>
                {m.officeReaction}
              </span>
            )}
          </span>
        )}
```

and replace

```tsx
      {!right && replyButton}
    </div>
  );
}
```

with

```tsx
      {!right && replyButton}
      {historyOpen && <EditHistoryDialog messageId={m.id} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx src/lib/api.test.ts`
Expected: PASS.

Run: `npm run typecheck -w web`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/components/conversation/MessageDialogs.tsx web/src/components/conversation/MessageBubble.tsx web/src/components/conversation/MessageBubble.test.tsx
git commit -m "feat(web): message action API calls, bubble tags, office reaction and edit history" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web forward dialog and sticker panel

**Files:**
- Modify: `web/src/components/conversation/MessageDialogs.tsx` (the import block; append `ForwardDialog`)
- Create: `web/src/components/conversation/StickerPanel.tsx`
- Modify: `web/src/components/conversation/Composer.tsx`:
  - imports at lines 1-11;
  - state after `botOpen` at line 76;
  - `sendSticker` after `toggleRecording` at lines 177-193;
  - the toolbar after the emoji block at lines 361-383.
- Test: `web/src/components/conversation/MessageDialogs.test.tsx` (create), `web/src/components/conversation/Composer.test.tsx` (new `describe` at the end)

**Interfaces:**
- Consumes:
  - Task 9: `api.messages.forward`, `ForwardInput`, `api.chats.sendSticker`, `api.chats.sendFile({ asSticker })`, `api.stickers.recent`, `qk.recentStickers`.
  - Task 1: `STICKER_MAX_BYTES`.
  - Existing: `BotRunningDialog`, `Modal`, `botRunningRuns`, `contactLabel`, `applyWsEvent`, `api.chats.list`, `api.contacts.list`, `qk.chatList`, `qk.contactList`, Composer's `submit`.
- Produces:
  - `ForwardDialog({ message, onClose })` (Task 11 opens it);
  - `StickerPanel({ onPick, onPickFile, onClose })`;
  - the Composer toolbar button "Figurinhas".

- [ ] **Step 1: Write the failing forward dialog tests**

Create `web/src/components/conversation/MessageDialogs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatListItem, ContactDto, MessageDto } from '@talk/shared';
import { ForwardDialog } from './MessageDialogs';

HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

/** A route is a JSON body (200) or a function of the call number returning a Response. */
function stubFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  const hits = new Map<string, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const key = `${method} ${url.pathname}`;
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      const route = routes[key];
      if (typeof route === 'function') return (route as (n: number) => Response)(n);
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const message = (over: Partial<MessageDto> = {}): MessageDto => ({
  id: 'm1', chatId: 'c1', direction: 'in', kind: 'text', body: 'Comprovante', media: null, mediaUnavailable: false,
  authorId: null, authorName: null, authorAvatarUrl: null, replyTo: null, reaction: null, status: 'read', error: null,
  sentAt: '2026-10-16T12:00:00.000Z', ...over,
});
const chatItem = (id: string, contactId: string, name: string): ChatListItem => ({
  id, contact: { id: contactId, name, phone: null, avatarUrl: null }, channelId: 'ch1', sectorId: 's1', ownerId: null,
  state: 'open', waiting: false, private: false, unread: 0, lastMessageAt: null, lastMessagePreview: null, pinned: false, tagIds: [],
});
const contact = (id: string, name: string): ContactDto => ({
  id, name, phone: null, lid: null, email: null, landline: null, address: null, blocked: false, tagIds: [], fields: {},
  createdAt: '2026-10-01T12:00:00.000Z', avatarUrl: null,
});

function renderDialog(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ForwardDialog message={message()} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

const SEARCH = {
  'GET /api/chats': { items: [chatItem('c2', 'k2', 'Maria Souza')], nextCursor: null },
  'GET /api/contacts': { items: [contact('k2', 'Maria Souza'), contact('k3', 'Mário Lima')], nextCursor: null },
};

describe('ForwardDialog', () => {
  it('searches open chats and contacts, lists each person once and forwards to the pick', async () => {
    stubFetch({ ...SEARCH, 'POST /api/messages/m1/forward': message({ id: 'm9', chatId: 'c3', direction: 'out' }) });
    const onClose = renderDialog();

    fireEvent.change(screen.getByLabelText('Conversa ou contato'), { target: { value: 'Ma' } });
    await screen.findByText('Conversas abertas'); // both searches answered
    expect(await screen.findByRole('button', { name: 'Mário Lima' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Maria Souza' })).toHaveLength(1); // her open chat, not her contact again
    fireEvent.click(screen.getByRole('button', { name: 'Mário Lima' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/messages/m1/forward', body: { contactId: 'k3' } },
    ]);
  });

  it('asks what to do with a running chatbot and retries with the choice', async () => {
    stubFetch({
      ...SEARCH,
      'POST /api/messages/m1/forward': (n: number) =>
        n === 1
          ? new Response(
              JSON.stringify({ error: 'O chatbot está em execução nesta conversa', code: 'BOT_RUNNING', runs: [{ id: 'r1', botName: 'Recepção' }] }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            )
          : new Response(JSON.stringify(message({ id: 'm9', chatId: 'c2' })), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const onClose = renderDialog();

    fireEvent.change(screen.getByLabelText('Conversa ou contato'), { target: { value: 'Ma' } });
    await screen.findByText('Conversas abertas'); // Maria is listed under her open chat, not as a contact
    await screen.findByRole('button', { name: 'Mário Lima' });
    fireEvent.click(screen.getByRole('button', { name: 'Maria Souza' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar e manter' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ chatId: 'c2' }, { chatId: 'c2', botAction: 'keep' }]);
  });

  it('shows the server refusal in Portuguese', async () => {
    stubFetch({
      ...SEARCH,
      'POST /api/messages/m1/forward': () =>
        new Response(JSON.stringify({ error: 'Esta mídia não está disponível para encaminhar' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        }),
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText('Conversa ou contato'), { target: { value: 'Ma' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mário Lima' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Esta mídia não está disponível para encaminhar');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/MessageDialogs.test.tsx`
Expected: FAIL. `ForwardDialog` is not exported by `./MessageDialogs`.

- [ ] **Step 3: Add the forward dialog**

In `web/src/components/conversation/MessageDialogs.tsx`, replace

```tsx
import { useQuery } from '@tanstack/react-query';
import type { MessageEditDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { Modal } from './ChatDialogs';
```

with

```tsx
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotAction, BotRunningErrorBody, MessageDto, MessageEditDto } from '@talk/shared';
import { api, botRunningRuns, qk, type ForwardInput } from '../../lib/api';
import { contactLabel } from '../../lib/format';
import { applyWsEvent } from '../../lib/ws';
import { BotRunningDialog, Modal } from './ChatDialogs';
import { errorMessage } from './model';
```

and append at the end of the file:

```tsx
const field = 'mt-1 block w-full rounded border border-field bg-surface px-2 py-1.5 text-sm text-fg';
const option = 'w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface disabled:opacity-50';

/**
 * Spec §7: one destination per forward, searched like "Nova conversa". Open chats come first; a contact with an open
 * chat is listed only there. A contact without one gets a new chat (server side). 409 BOT_RUNNING asks, then retries.
 */
export function ForwardDialog({ message, onClose }: { message: MessageDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botAsk, setBotAsk] = useState<{ runs: BotRunningErrorBody['runs']; resolve: (a: BotAction | null) => void } | null>(null);
  const term = text.trim();
  const searching = term.length >= 2;

  // ponytail: one request per keystroke (cached per term), like NewChatDialog; debounce if search gets slow
  const chatQuery = { tab: 'inbox' as const, q: term, limit: 5 };
  const chats = useQuery({ queryKey: qk.chatList(chatQuery), queryFn: () => api.chats.list(chatQuery), enabled: searching });
  const contactQuery = { q: term, limit: 5 };
  const contacts = useQuery({ queryKey: qk.contactList(contactQuery), queryFn: () => api.contacts.list(contactQuery), enabled: searching });
  const openChats = searching ? (chats.data?.items ?? []) : [];
  const inOpenChat = new Set(openChats.map((c) => c.contact.id));
  const others = searching ? (contacts.data?.items ?? []).filter((c) => !inOpenChat.has(c.id)) : [];

  async function forward(to: ForwardInput) {
    setBusy(true);
    setError(null);
    try {
      let sent: MessageDto;
      try {
        sent = await api.messages.forward(message.id, to);
      } catch (e) {
        const runs = botRunningRuns(e);
        if (!runs) throw e;
        const choice = await new Promise<BotAction | null>((resolve) => setBotAsk({ runs, resolve }));
        if (!choice) return; // Cancelar: stay in the dialog
        sent = await api.messages.forward(message.id, { ...to, botAction: choice });
      }
      applyWsEvent(qc, { type: 'message.created', message: sent }); // lands in the destination's cached timeline, if any
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Encaminhar mensagem" onCancel={onClose}>
      <label className="block text-sm">
        Conversa ou contato
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Nome ou telefone" className={field} />
      </label>
      {openChats.length > 0 && (
        <section className="mt-3">
          <h4 className="px-2 text-xs font-semibold text-muted">Conversas abertas</h4>
          <ul>
            {openChats.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => void forward({ chatId: c.id })} className={option}>
                  {contactLabel(c.contact)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="mt-3">
          <h4 className="px-2 text-xs font-semibold text-muted">Contatos</h4>
          <ul>
            {others.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => void forward({ contactId: c.id })} className={option}>
                  {contactLabel(c)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {searching && chats.isSuccess && contacts.isSuccess && openChats.length === 0 && others.length === 0 && (
        <p className="mt-3 text-sm text-muted">Nenhuma conversa ou contato encontrado.</p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm hover:bg-surface">
          Cancelar
        </button>
      </div>
      {botAsk && (
        <BotRunningDialog
          runs={botAsk.runs}
          onChoose={(choice) => {
            botAsk.resolve(choice);
            setBotAsk(null);
          }}
        />
      )}
    </Modal>
  );
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -w web -- src/components/conversation/MessageDialogs.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing sticker tests**

In `web/src/components/conversation/Composer.test.tsx`, append at the end of the file:

```tsx
describe('Composer stickers', () => {
  it('sends a recent sticker by id', async () => {
    stubFetch({
      'GET /api/stickers/recent': [{ messageId: 's1', url: '/api/media/s1' }],
      'POST /api/chats/c1/messages': message({ kind: 'sticker', body: null }),
    });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Figurinhas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar figurinha' }));
    await waitFor(() => expect(posts('/api/chats/c1/messages')).toHaveLength(1));
    expect(posts('/api/chats/c1/messages')[0]!.body).toEqual({ stickerFromMessageId: 's1' });
  });

  it('sends a picked image as a sticker and refuses a file over 1 MB', async () => {
    stubFetch({ 'GET /api/stickers/recent': [], 'POST /api/chats/c1/messages': message({ kind: 'sticker', body: null }) });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Figurinhas' }));
    expect(await screen.findByText('Nenhuma figurinha ainda.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar imagem como figurinha' })).toBeTruthy();
    const input = screen.getByLabelText('Imagem para figurinha');

    fireEvent.change(input, { target: { files: [new File([new Uint8Array(1024 * 1024 + 1)], 'grande.png', { type: 'image/png' })] } });
    expect(screen.getByRole('alert').textContent).toBe('Envie uma imagem PNG, JPEG ou WebP de até 1 MB');
    expect(posts('/api/chats/c1/messages')).toHaveLength(0);

    fireEvent.change(input, { target: { files: [new File(['png'], 'fig.png', { type: 'image/png' })] } });
    await waitFor(() => expect(posts('/api/chats/c1/messages')).toHaveLength(1));
    const form = posts('/api/chats/c1/messages')[0]!.body as FormData;
    expect(form.get('asSticker')).toBe('true');
    expect((form.get('file') as File).name).toBe('fig.png');
  });

  it('has no sticker button in note mode', () => {
    stubFetch({});
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Nota interna' }));
    expect(screen.queryByRole('button', { name: 'Figurinhas' })).toBeNull();
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/Composer.test.tsx`
Expected: FAIL. `Unable to find an accessible element with the role "button" and name "Figurinhas"`.

- [ ] **Step 7: Create the sticker panel**

Create `web/src/components/conversation/StickerPanel.tsx`:

```tsx
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { STICKER_MAX_BYTES } from '@talk/shared';
import { api, qk } from '../../lib/api';

const STICKER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface StickerPanelProps {
  onPick: (messageId: string) => void;
  onPickFile: (file: File) => void;
  onClose: () => void;
}

/** Composer popover (spec §6): the 40 recent stickers, plus "Enviar imagem como figurinha" (PNG/JPEG/WebP up to 1 MB). */
export function StickerPanel({ onPick, onPickFile, onClose }: StickerPanelProps) {
  const recent = useQuery({ queryKey: qk.recentStickers, queryFn: api.stickers.recent });
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      role="dialog"
      aria-label="Figurinhas"
      className="absolute bottom-full left-0 z-10 mb-1 w-80 rounded-md border border-border bg-panel p-2 text-sm text-fg shadow-lg"
    >
      <p className="mb-2 text-xs font-semibold text-muted">Figurinhas recentes</p>
      {recent.isPending && <p className="text-muted">Carregando…</p>}
      {recent.isError && <p className="text-danger">Não foi possível carregar as figurinhas.</p>}
      {recent.data?.length === 0 && <p className="text-muted">Nenhuma figurinha ainda.</p>}
      <div className="grid max-h-64 grid-cols-5 gap-1 overflow-y-auto">
        {recent.data?.map((s) => (
          <button
            key={s.messageId}
            type="button"
            aria-label="Enviar figurinha"
            onClick={() => {
              onPick(s.messageId);
              onClose();
            }}
            className="rounded p-1 hover:bg-surface"
          >
            <img src={s.url} alt="" loading="lazy" className="size-12 object-contain" />
          </button>
        ))}
      </div>
      <button type="button" onClick={() => fileRef.current?.click()} className="mt-2 w-full rounded px-2 py-1.5 text-left hover:bg-surface">
        Enviar imagem como figurinha
      </button>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept={STICKER_TYPES.join(',')}
        aria-label="Imagem para figurinha"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // picking the same file again still fires onChange
          if (!file) return;
          if (!STICKER_TYPES.includes(file.type) || file.size > STICKER_MAX_BYTES) {
            setError('Envie uma imagem PNG, JPEG ou WebP de até 1 MB');
            return;
          }
          onPickFile(file);
          onClose();
        }}
      />
      {error && (
        <p role="alert" className="mt-1 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Add the button to the composer**

In `web/src/components/conversation/Composer.tsx`, replace

```ts
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Robot, Smiley, Trash, X } from '@phosphor-icons/react';
```

with

```ts
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Robot, Smiley, Sticker, Trash, X } from '@phosphor-icons/react';
```

replace

```ts
import { QuickAnswerPicker, filterQuickAnswers } from './QuickAnswerPicker';
```

with

```ts
import { QuickAnswerPicker, filterQuickAnswers } from './QuickAnswerPicker';
import { StickerPanel } from './StickerPanel';
```

replace

```ts
  const [botOpen, setBotOpen] = useState(false);
```

with

```ts
  const [botOpen, setBotOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
```

replace

```ts
    if (ok && replyRef.current === sentReply) onClearReply();
  }

  async function pickAnswer(qa: QuickAnswerDto) {
```

with

```ts
    if (ok && replyRef.current === sentReply) onClearReply();
  }

  /** Spec §6: a recent sticker (by message id) or a picked image sent as a sticker; same BOT_RUNNING flow as any send. */
  async function sendSticker(pick: { messageId: string } | { file: File }) {
    const sentReply = replyTo;
    const ok = await submit((botAction) =>
      'messageId' in pick
        ? api.chats.sendSticker(chatId, { stickerFromMessageId: pick.messageId, replyToId: sentReply?.id, botAction })
        : api.chats.sendFile(chatId, { file: pick.file, signature: false, asSticker: true, replyToId: sentReply?.id, botAction }),
    );
    if (ok && replyRef.current === sentReply) onClearReply();
  }

  async function pickAnswer(qa: QuickAnswerDto) {
```

and replace

```tsx
            <div className="relative">
              <ToolButton label="Chatbot" onClick={() => setBotOpen((o) => !o)}>
```

with

```tsx
            {!isNote && (
              <div className="relative">
                <ToolButton label="Figurinhas" onClick={() => setStickerOpen((o) => !o)}>
                  <Sticker size={20} />
                </ToolButton>
                {stickerOpen && (
                  <StickerPanel
                    onPick={(messageId) => void sendSticker({ messageId })}
                    onPickFile={(file) => void sendSticker({ file })}
                    onClose={() => setStickerOpen(false)}
                  />
                )}
              </div>
            )}
            <div className="relative">
              <ToolButton label="Chatbot" onClick={() => setBotOpen((o) => !o)}>
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/conversation/Composer.test.tsx src/components/conversation/MessageDialogs.test.tsx`
Expected: PASS.

Run: `npm run typecheck -w web`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add web/src/components/conversation/MessageDialogs.tsx web/src/components/conversation/MessageDialogs.test.tsx web/src/components/conversation/StickerPanel.tsx web/src/components/conversation/Composer.tsx web/src/components/conversation/Composer.test.tsx
git commit -m "feat(web): forward dialog and recent stickers panel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Web bubble action menu, in-place edit and delete

**Files:**
- Create: `web/src/components/conversation/MessageMenu.tsx`
- Modify: `web/src/components/conversation/MessageBubble.tsx` (the whole file is replaced; `MediaView`, `StatusTick` and `formatSize` keep their code)
- Modify: `web/src/components/conversation/Timeline.tsx` (props at line 11, bubble at line 98)
- Modify: `web/src/components/conversation/ConversationView.tsx` (`<Timeline …>` at line 99)
- Test: `web/src/components/conversation/MessageBubble.test.tsx` (imports, `renderBubble`, new `describe`)

**Interfaces:**
- Consumes:
  - Task 1: `reactBlock`, `replyBlock`, `forwardBlock`, `editBlock`, `deleteBlock`, `isSingleEmoji`, `QUICK_REACTIONS`, `ActionBlock`.
  - Task 9: `api.messages.react/remove/edit`, `EditHistoryDialog`, the bubble tags.
  - Task 10: `ForwardDialog`.
  - Existing: `confirmDialog` (`web/src/lib/confirm.ts`), `qk.me`, `applyWsEvent`.
- Produces:
  - `menuItems(m: MessageDto, meId: string | null, chatOpen: boolean, now: number): MenuItem[]`, plus `MenuAction` and `MenuItem { action; label; hint: string | null }`;
  - `MessageMenu(props)`;
  - the props `MessageBubble({ m, onReply, chatOpen? })` and `Timeline({ chatId, onReply, chatOpen? })`;
  - accessible names that tests rely on:
    - trigger button: "Ações da mensagem";
    - menu items (role `menuitem`): "Reagir", "Responder", "Encaminhar", "Copiar", "Editar", "Apagar para todos";
    - quick reactions: "Reagir com <emoji>";
    - the "Outro emoji" input;
    - the "Editar mensagem" textarea.

- [ ] **Step 1: Write the failing menu tests**

In `web/src/components/conversation/MessageBubble.test.tsx`, replace

```ts
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto } from '@talk/shared';
import { MessageBubble } from './MessageBubble';
```

with

```ts
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, MessageDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { MessageBubble } from './MessageBubble';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));
```

Replace the whole `renderBubble` function

```ts
function renderBubble(m: MessageDto) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble m={m} onReply={() => {}} />
    </QueryClientProvider>,
  ).container;
}
```

with

```ts
const ME: Me = {
  id: 'u1', name: 'Ana Lima', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null,
};

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

and append at the end of the file:

```ts
describe('MessageBubble action menu', () => {
  const recent = { ...base, sentAt: new Date(Date.now() - 60_000).toISOString() };
  const ago = (ms: number) => ({ ...base, sentAt: new Date(Date.now() - ms).toISOString() });
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
  const labels = () => screen.getAllByRole('menuitem').map((b) => b.firstChild?.textContent);
  const item = (name: string) => screen.getByRole('menuitem', { name: new RegExp(`^${name}`) }) as HTMLButtonElement;

  it('offers every action on my recent text in an open chat', () => {
    renderBubble(recent, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar', 'Editar', 'Apagar para todos']);
    expect(screen.getAllByRole('menuitem').every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('keeps expired actions, disabled, with the hint', () => {
    renderBubble(ago(20 * 60_000), { chatOpen: true });
    openMenu();
    expect(item('Editar').disabled).toBe(true);
    expect(item('Editar').textContent).toBe('EditarSó até 15 min após o envio');
    expect(item('Apagar para todos').disabled).toBe(false);
    cleanup();
    renderBubble(ago(49 * 3_600_000), { chatOpen: true });
    openMenu();
    expect(item('Apagar para todos').disabled).toBe(true);
    expect(screen.getByText('Só até 48 h após o envio')).toBeTruthy();
  });

  it('leaves out what does not apply: inbound, deleted and closed-chat messages', () => {
    renderBubble({ ...recent, direction: 'in', authorId: null, authorName: null, authorAvatarUrl: null }, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar']);
    cleanup();
    renderBubble({ ...recent, deleted: { at: recent.sentAt, source: 'office', byName: 'Ana Lima' } }, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Copiar']);
    cleanup();
    renderBubble(recent, { chatOpen: false });
    openMenu();
    expect(labels()).toEqual(['Copiar']);
  });

  it('reacts with a quick emoji', async () => {
    stubFetch({ 'POST /api/messages/m1/reaction': { ...recent, officeReaction: '👍' } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Reagir'));
    fireEvent.click(screen.getByRole('button', { name: 'Reagir com 👍' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/messages/m1/reaction', body: { emoji: '👍' } }]));
  });

  it('reacts with another emoji typed or picked in the box, one only', async () => {
    stubFetch({ 'POST /api/messages/m1/reaction': { ...recent, officeReaction: '🎉' } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Reagir'));
    const box = screen.getByLabelText('Outro emoji');
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Escolha um emoji');
    fireEvent.change(box, { target: { value: '🎉🎉' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/messages/m1/reaction', body: { emoji: '🎉' } }]));
  });

  it('asks before deleting for everyone, with the spec text', async () => {
    stubFetch({ 'DELETE /api/messages/m1': { ...recent, deleted: { at: recent.sentAt, source: 'office', byName: 'Ana Lima' } } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Apagar para todos'));
    await waitFor(() => expect(calls).toEqual([{ method: 'DELETE', path: '/api/messages/m1', body: undefined }]));
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Apagar para todos?', body: 'O contato deixa de ver esta mensagem.', confirmLabel: 'Apagar para todos',
    });
  });

  it('edits in place: Esc cancels, Enter saves', async () => {
    stubFetch({ 'PATCH /api/messages/m1': { ...recent, body: 'Olá, tudo bem?' } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Editar'));
    const box = () => screen.getByLabelText('Editar mensagem') as HTMLTextAreaElement;
    expect(box().value).toBe('Olá');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByLabelText('Editar mensagem')).toBeNull();

    openMenu();
    fireEvent.click(item('Editar'));
    fireEvent.change(box(), { target: { value: 'Olá, tudo bem?' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByLabelText('Editar mensagem')).toBeNull());
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/messages/m1', body: { text: 'Olá, tudo bem?' } }]);
  });

  it('opens the forward dialog', () => {
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Encaminhar'));
    expect(screen.getByRole('dialog', { name: 'Encaminhar mensagem' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx`
Expected: FAIL with `Unable to find an accessible element with the role "button" and name "Ações da mensagem"`. Vitest does not typecheck, so the not-yet-existing `chatOpen` prop does not stop the run.

- [ ] **Step 3: Create the menu**

Create `web/src/components/conversation/MessageMenu.tsx`:

```tsx
import { useState, type KeyboardEvent } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import {
  QUICK_REACTIONS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, reactBlock, replyBlock, type ActionBlock, type MessageDto,
} from '@talk/shared';

export type MenuAction = 'react' | 'reply' | 'forward' | 'copy' | 'edit' | 'delete';
/** hint set = the action applies but its time is over: shown disabled with the hint. */
export interface MenuItem { action: MenuAction; label: string; hint: string | null }

/**
 * Spec §9: Reagir · Responder · Encaminhar · Copiar · Editar · Apagar para todos. An action that does not apply to
 * this message is left out; one whose time is over stays, disabled, with its hint. A closed chat only offers Copiar.
 */
export function menuItems(m: MessageDto, meId: string | null, chatOpen: boolean, now: number): MenuItem[] {
  const items: MenuItem[] = [];
  const add = (action: MenuAction, label: string, block: ActionBlock | null) => {
    if (!block) items.push({ action, label, hint: null });
    else if (block.expired) items.push({ action, label, hint: block.reason });
  };
  if (chatOpen) {
    add('react', 'Reagir', reactBlock(m));
    add('reply', 'Responder', replyBlock(m));
    add('forward', 'Encaminhar', forwardBlock(m));
  }
  if (m.body) items.push({ action: 'copy', label: 'Copiar', hint: null });
  if (chatOpen) {
    add('edit', 'Editar', editBlock(m, meId, now));
    add('delete', 'Apagar para todos', deleteBlock(m, now));
  }
  return items;
}

const firstGrapheme = (s: string) => [...new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(s.trim())][0]?.segment ?? '';

export interface MessageMenuProps {
  items: MenuItem[];
  officeReaction: string | null;
  /** Bubble on the right (sent): the menu opens toward the left. */
  alignRight: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: Exclude<MenuAction, 'react'>) => void;
  onReact: (emoji: string) => void;
}

/**
 * Hover (or a long press, through the bubble's contextmenu) shows the trigger. "Reagir" swaps the list for the quick
 * reactions plus a box where the system emoji picker (Win + . / Ctrl + Cmd + Space) or the phone keyboard types one.
 */
export function MessageMenu(props: MessageMenuProps) {
  const [reacting, setReacting] = useState(false);
  const [other, setOther] = useState('');
  const [otherError, setOtherError] = useState(false);
  if (props.items.length === 0) return null;

  function close() {
    setReacting(false);
    setOther('');
    setOtherError(false);
    props.onOpenChange(false);
  }

  function pick(action: MenuAction) {
    if (action === 'react') {
      setReacting(true);
      return;
    }
    close();
    props.onAction(action);
  }

  function react(emoji: string) {
    close();
    props.onReact(emoji);
  }

  function onOtherKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const emoji = firstGrapheme(other);
    if (isSingleEmoji(emoji)) react(emoji);
    else setOtherError(true);
  }

  return (
    <div
      className="relative self-center"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <button
        type="button"
        aria-label="Ações da mensagem"
        title="Ações da mensagem"
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={() => (props.open ? close() : props.onOpenChange(true))}
        className="p-1 text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
      >
        <CaretDown size={16} />
      </button>
      {props.open && (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={close} />
          <div
            role="menu"
            aria-label="Ações da mensagem"
            className={`absolute top-full z-20 mt-1 w-60 rounded-md border border-border bg-panel py-1 text-sm text-fg shadow-lg ${
              props.alignRight ? 'right-0' : 'left-0'
            }`}
          >
            {reacting ? (
              <div className="px-2 py-1">
                <div className="flex gap-1">
                  {QUICK_REACTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      aria-label={`Reagir com ${e}`}
                      aria-pressed={props.officeReaction === e}
                      onClick={() => react(e)}
                      className="rounded px-1 text-lg hover:bg-surface aria-pressed:bg-primary/25"
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <input
                  aria-label="Outro emoji"
                  autoFocus
                  value={other}
                  placeholder="Mais: Win + . ou cole um emoji e Enter"
                  onChange={(e) => {
                    setOther(e.target.value);
                    setOtherError(false);
                  }}
                  onKeyDown={onOtherKey}
                  className="mt-2 w-full rounded border border-field bg-surface px-2 py-1 text-sm"
                />
                {otherError && (
                  <p role="alert" className="mt-1 text-xs text-danger">
                    Escolha um emoji
                  </p>
                )}
              </div>
            ) : (
              props.items.map((it) => (
                <button
                  key={it.action}
                  type="button"
                  role="menuitem"
                  disabled={it.hint !== null}
                  onClick={() => pick(it.action)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span>{it.label}</span>
                  {it.hint && <span className="block text-xs text-muted">{it.hint}</span>}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Put the menu, the edit mode and the delete in the bubble**

Replace the whole content of `web/src/components/conversation/MessageBubble.tsx` with:

```tsx
import { useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Checks, Clock, FileText, ImageBroken, Robot, ShareFat, WarningCircle } from '@phosphor-icons/react';
import type { Me, MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { Avatar } from '../Avatar';
import { applyWsEvent } from '../../lib/ws';
import { EditHistoryDialog, ForwardDialog } from './MessageDialogs';
import { MessageMenu, menuItems, type MenuAction } from './MessageMenu';
import { deletedTag, editedTag, errorMessage, previewText, timeOfDay } from './model';

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);
const chip = 'rounded-full border border-border bg-surface px-1.5 text-sm shadow-sm';

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
      return <Checks size={14} weight="bold" className="text-read" aria-label="Lida" />;
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

export interface MessageBubbleProps {
  m: MessageDto;
  onReply: (m: MessageDto) => void;
  /** Spec §2: no action in a closed chat (only Copiar). */
  chatOpen?: boolean;
}

export function MessageBubble({ m, onReply, chatOpen = false }: MessageBubbleProps) {
  const qc = useQueryClient();
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const isNote = m.kind === 'note';
  const right = isNote || m.direction === 'out';
  const showStatus = m.direction === 'out' && !isNote;
  // a chatbot run sends as the system (authorId null) and the server fills botName
  const botName = !isNote && m.direction === 'out' ? (m.botName ?? null) : null;
  const label = isNote
    ? `Nota interna · ${m.authorName ?? 'Atendente'}`
    : botName
      ? `Chatbot ${botName}`
      : m.direction === 'out'
        ? (m.authorName ?? 'Celular ou sistema') // authorId null = sent from the phone or by the triage
        : null;
  const tone = isNote ? 'bg-yellow-200 text-zinc-900' : m.direction === 'out' ? 'bg-primary/25 text-fg' : 'bg-bubble-in text-fg';
  // me is loaded before any chat renders (RequireAuth); read it without subscribing
  const meId = qc.getQueryData<Me | null>(qk.me)?.id ?? null;
  const items = menuItems(m, meId, chatOpen, Date.now());

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

  /** Runs one action; its answer goes through the same cache path as the WS echo. */
  async function act(call: () => Promise<MessageDto>): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      applyWsEvent(qc, { type: 'message.updated', message: await call() });
      return true;
    } catch (e) {
      setActionError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(m.body ?? '');
    } catch {
      setActionError('Não foi possível copiar');
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Apagar para todos?',
      body: 'O contato deixa de ver esta mensagem.',
      confirmLabel: 'Apagar para todos',
    });
    if (ok) await act(() => api.messages.remove(m.id));
  }

  function onAction(action: Exclude<MenuAction, 'react'>) {
    if (action === 'reply') onReply(m);
    else if (action === 'forward') setForwarding(true);
    else if (action === 'copy') void copy();
    else if (action === 'edit') {
      setDraft(m.body ?? '');
      setActionError(null);
      setEditing(true);
    } else void remove();
  }

  async function saveEdit() {
    const text = draft.trim();
    if (!text || busy) return;
    if (await act(() => api.messages.edit(m.id, text))) setEditing(false);
  }

  function onEditKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      setActionError(null);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void saveEdit();
    }
  }

  const menu = (
    <MessageMenu
      items={items}
      officeReaction={m.officeReaction ?? null}
      alignRight={right}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onAction={onAction}
      onReact={(emoji) => void act(() => api.messages.react(m.id, emoji))}
    />
  );

  return (
    <div className={`group flex px-4 py-1 ${right ? 'justify-end' : 'justify-start'}`}>
      {right && menu}
      <div
        onContextMenu={(e) => {
          // a long press on touch screens fires contextmenu: open the same menu (spec §9 "toque longo")
          if (items.length === 0 || editing) return;
          e.preventDefault();
          setMenuOpen(true);
        }}
        className={`relative max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${tone} ${m.reaction || m.officeReaction ? 'mb-3' : ''}`}
      >
        {label && (
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold opacity-75">
            {botName && <Robot size={14} weight="fill" aria-hidden data-bot-icon className="shrink-0" />}
            {label}
          </p>
        )}
        {m.forwarded && (
          <p data-tag="forwarded" className="mb-1 flex items-center gap-1 text-xs italic opacity-70">
            <ShareFat size={12} aria-hidden /> Encaminhada
          </p>
        )}
        {m.replyTo && (
          <div className="mb-1 line-clamp-3 rounded border-l-4 border-primary bg-black/15 px-2 py-1 text-xs opacity-80">
            {previewText(m.replyTo.body, m.replyTo.kind)}
          </div>
        )}
        <MediaView m={m} />
        {editing ? (
          <div>
            <textarea
              aria-label="Editar mensagem"
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKey}
              className="field-sizing-content block max-h-48 min-h-10 w-72 max-w-full resize-none rounded border border-field bg-panel px-2 py-1 text-sm text-fg outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="mt-1 text-xs opacity-70">Enter salva · Esc cancela</p>
          </div>
        ) : m.kind === 'unsupported' ? (
          <p className="text-sm italic opacity-70">Mensagem não suportada</p>
        ) : (
          m.body && <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-xs opacity-70">
          {m.deleted && (
            <span data-tag="deleted" className="font-medium text-danger">
              {deletedTag(m.deleted)}
            </span>
          )}
          {m.edited && (
            <button
              type="button"
              data-tag="edited"
              title="Ver versões anteriores"
              onClick={() => setHistoryOpen(true)}
              className="hover:underline"
            >
              {editedTag(m.edited)}
            </button>
          )}
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
        {actionError && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {actionError}
          </p>
        )}
        {(m.reaction || m.officeReaction) && (
          <span className={`absolute -bottom-3 ${right ? 'left-2' : 'right-2'} flex gap-0.5`}>
            {m.reaction && (
              <span aria-label={`Reação do contato ${m.reaction}`} className={chip}>
                {m.reaction}
              </span>
            )}
            {m.officeReaction && (
              <span aria-label={`Reação do escritório ${m.officeReaction}`} className={chip}>
                {m.officeReaction}
              </span>
            )}
          </span>
        )}
      </div>
      {m.authorId && (
        // sent by an agent (notes included); phone/triage sends have no author
        <span data-author-avatar className="ml-2 self-end">
          <Avatar name={m.authorName} src={m.authorAvatarUrl} className="size-7 text-xs bg-primary text-white" />
        </span>
      )}
      {!right && menu}
      {historyOpen && <EditHistoryDialog messageId={m.id} onClose={() => setHistoryOpen(false)} />}
      {forwarding && <ForwardDialog message={m} onClose={() => setForwarding(false)} />}
    </div>
  );
}
```

- [ ] **Step 5: Pass whether the chat is open**

In `web/src/components/conversation/Timeline.tsx`, replace

```tsx
export function Timeline({ chatId, onReply }: { chatId: string; onReply: (m: MessageDto) => void }) {
```

with

```tsx
export function Timeline({
  chatId,
  onReply,
  chatOpen = false,
}: {
  chatId: string;
  onReply: (m: MessageDto) => void;
  /** Spec §2: message actions only in an open chat. */
  chatOpen?: boolean;
}) {
```

and

```tsx
        return <MessageBubble key={row.key} m={item} onReply={onReply} />;
```

with

```tsx
        return <MessageBubble key={row.key} m={item} onReply={onReply} chatOpen={chatOpen} />;
```

In `web/src/components/conversation/ConversationView.tsx`, replace

```tsx
      <Timeline chatId={chatId} onReply={setReplyTo} />
```

with

```tsx
      <Timeline chatId={chatId} onReply={setReplyTo} chatOpen={chat.state === 'open'} />
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx src/components/conversation/Timeline.test.tsx`
Expected: PASS.

Run: `npm test -w web` and `npm run typecheck -w web`
Expected: every web test passes; typecheck exits 0.

- [ ] **Step 7: Check it in the browser**

Run: `npm run dev:up` and `npm run dev`, and log in.
1. In an open chat, hover a sent message. The caret button appears, and its menu lists the six items.
2. A message older than 15 min shows "Editar" greyed out with "Só até 15 min após o envio".
3. Right-click a bubble: the same menu opens. This is the long-press path on touch screens.
4. Switch the theme: the menu, the tags and the reaction chips stay readable in both light and dark.

Expected: as described, with no console errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/conversation/MessageMenu.tsx web/src/components/conversation/MessageBubble.tsx web/src/components/conversation/MessageBubble.test.tsx web/src/components/conversation/Timeline.tsx web/src/components/conversation/ConversationView.tsx
git commit -m "feat(web): message action menu with reactions, in-place edit and delete for everyone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docs and manual acceptance

This task is docs only, with no code. The acceptance script follows spec §11 and quotes the on-screen labels from Tasks 9-11. Step 3 checks each quoted label against the code. When a label is missing, fix the doc wording; never change code in this task. All doc text is pt-BR, like the rest of `docs/`.

**Files:**
- Create: `docs/superpowers/plans/2026-10-16-acoes-mensagem-aceite.md`
- Modify: `docs/IMPLANTACAO.md` ("Teste manual com um número de teste" list, after the reaction line)

**Interfaces:**
- Consumes: the UI labels:
  - "Ações da mensagem", "Reagir", "Responder", "Encaminhar", "Copiar", "Editar", "Apagar para todos";
  - "Apagar para todos?", "O contato deixa de ver esta mensagem.";
  - "Só até 15 min após o envio", "Só até 48 h após o envio";
  - "Apagada pelo contato", "Apagada por", "Apagada pelo celular", "editada", "editada pelo contato", "editada pelo contato (novo texto indisponível)", "Encaminhada";
  - "Figurinhas", "Figurinhas recentes", "Enviar imagem como figurinha", "Envie uma imagem PNG, JPEG ou WebP de até 1 MB";
  - "Encaminhar mensagem", "Conversa ou contato", "Esta mídia não está disponível para encaminhar";
  - "Versões anteriores", "Outro emoji".
  - The log line `webhook sync failed`.
- Produces: nothing that code depends on.

- [ ] **Step 1: Run the doc check and confirm it fails**

Run (bash, repo root):
```bash
grep -c -e 'Apagar para todos' -e 'Enviar imagem como figurinha' -e 'MESSAGES_DELETE' docs/superpowers/plans/2026-10-16-acoes-mensagem-aceite.md
grep -c -e 'acoes-mensagem-aceite' docs/IMPLANTACAO.md
```
Expected: FAIL. The first command prints `No such file or directory`, and the second prints `0`.

- [ ] **Step 2: Write the acceptance script and the checklist line**

Create `docs/superpowers/plans/2026-10-16-acoes-mensagem-aceite.md` with exactly:

````markdown
# Aceite manual: ações de mensagem

Roteiro do §11 da [especificação](../specs/2026-10-16-acoes-mensagem-design.md). Rode no ambiente local, com o número de teste e um segundo celular fazendo o papel do cliente.

> ⚠️ Use só o **número de teste**. Se você ler o QR com o número do escritório, ele sai do Umbler Talk na hora.

## 0. Antes de começar

- [ ] Testes automáticos passando:

```bash
npm test
npm run typecheck
```

- [ ] O ambiente local está rodando (`npm run dev:up` e `npm run dev`), e o canal do número de teste aparece como **Conectado**.
- [ ] No log do app, logo depois de subir, **não** aparece `webhook sync failed`.
- [ ] A instância recebe os eventos novos. Troque `<instância>` pelo nome em Configurações › Canais (`talk-…`) e rode:

```bash
curl -s -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8081/webhook/find/<instância>
```

  O campo `events` precisa ter `MESSAGES_DELETE` e **não** pode ter `MESSAGES_EDITED`.
- [ ] Existe uma conversa aberta com o celular do "cliente", atribuída a você.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

## A. Reagir

- [ ] Passe o mouse numa mensagem do cliente, clique em **Ações da mensagem** › **Reagir** › 👍. A reação aparece abaixo da bolha e no celular do cliente.
- [ ] Reaja com ❤️: troca no celular. Reaja ❤️ de novo: a reação some.
- [ ] Em **Reagir**, clique no campo **Outro emoji**, abra os emojis do Windows (`Win + .`), escolha um e tecle Enter.
- [ ] O cliente reage a uma mensagem nossa e nós reagimos à mesma: as duas reações aparecem lado a lado.
- [ ] Reaja pelo **celular do escritório**: no sistema ela aparece como reação do escritório, sem apagar a do cliente.

## B. Apagar para todos

- [ ] Envie "teste apagar". Em **Ações da mensagem** › **Apagar para todos**, a pergunta "Apagar para todos?" aparece com "O contato deixa de ver esta mensagem.". Confirme.
- [ ] A mensagem some no celular do cliente. No sistema o texto continua, com a tag **Apagada por <seu nome>**, e a linha do tempo mostra "Mensagem apagada por <seu nome>".
- [ ] Mensagem do cliente: o menu não tem **Editar** nem **Apagar para todos**.
- [ ] Numa mensagem nossa com mais de 48 h, **Apagar para todos** aparece desabilitado com "Só até 48 h após o envio".
- [ ] Apague uma mensagem pelo **celular do escritório**: no sistema aparece a tag **Apagada pelo celular**.

## C. Editar

- [ ] Envie "reunião às 14h". Em **Editar**, troque por "reunião às 15h" e tecle Enter. Muda no celular do cliente (com "Editada"), e no sistema aparece a tag **editada**.
- [ ] Clique em **editada**: "Versões anteriores" mostra "reunião às 14h" com data e hora.
- [ ] Comece outra edição e tecle Esc: nada muda.
- [ ] Depois de 15 min, **Editar** fica desabilitado com "Só até 15 min após o envio".

## D. O contato apaga e edita

- [ ] O cliente apaga uma mensagem para todos. No sistema o texto **continua visível**, com a tag **Apagada pelo contato**.
- [ ] O cliente edita uma mensagem. Aparece o texto novo com a tag **editada pelo contato**, e clicar nela mostra o texto anterior.
- [ ] Se o WhatsApp do cliente usar o formato novo de edição, a tag é **editada pelo contato (novo texto indisponível)**. O texto anterior continua, e **não** surge uma bolha "Mensagem não suportada".
- Qual dos dois apareceu? `________`

## E. Figurinhas

- [ ] Peça ao cliente para mandar uma figurinha. No compositor, **Figurinhas** mostra ela em "Figurinhas recentes". Clique nela: a figurinha chega no celular do cliente.
- [ ] Mande a mesma figurinha duas vezes: a lista não a repete.
- [ ] **Enviar imagem como figurinha** com um PNG pequeno: chega como figurinha.
- [ ] Um arquivo de mais de 1 MB mostra "Envie uma imagem PNG, JPEG ou WebP de até 1 MB".

## F. Encaminhar

- [ ] Numa foto do cliente, use **Encaminhar** e, em **Conversa ou contato**, digite o nome de outra conversa aberta e clique nela. A foto chega no outro celular, e a bolha nova tem a tag **Encaminhada**. No celular não aparece a marca "Encaminhada" do WhatsApp: é uma limitação da Evolution 2.3.7.
- [ ] Encaminhe para um contato **sem** conversa aberta: abre uma conversa nova, atribuída a você.
- [ ] Encaminhe uma mídia que mostra "mídia indisponível": aparece "Esta mídia não está disponível para encaminhar".

## Pontos para anotar

- Número com o 9º dígito (DDD 31 ou maior): apagar, reagir e editar funcionaram? `________`
- Contato só com LID (sem telefone): apagar e editar funcionaram? `________`
- Se a Evolution recusar uma edição ("Não foi possível editar no WhatsApp"), confira se `DATABASE_SAVE_DATA_NEW_MESSAGE` está `"true"`: a edição exige a mensagem original no banco da Evolution.
````

In `docs/IMPLANTACAO.md`, replace

```markdown
- [ ] Reação do contato aparece na mensagem. Um 👍 numa conversa **finalizada** não reabre a conversa.
```

with

```markdown
- [ ] Reação do contato aparece na mensagem. Um 👍 numa conversa **finalizada** não reabre a conversa.
- [ ] Ações de mensagem (reagir, apagar, editar, figurinhas, encaminhar): o [roteiro de aceite](superpowers/plans/2026-10-16-acoes-mensagem-aceite.md) passa inteiro, com as partes A a F marcadas.
```

- [ ] **Step 3: Check every quoted label against the code**

Run (bash, repo root):
```bash
for s in 'Ações da mensagem' 'Apagar para todos?' 'O contato deixa de ver esta mensagem.' 'Só até 15 min após o envio' 'Só até 48 h após o envio' 'Apagada pelo contato' 'Apagada pelo celular' 'editada pelo contato' '(novo texto indisponível)' 'Encaminhada' 'Figurinhas recentes' 'Enviar imagem como figurinha' 'Envie uma imagem PNG, JPEG ou WebP de até 1 MB' 'Encaminhar mensagem' 'Conversa ou contato' 'Esta mídia não está disponível para encaminhar' 'Versões anteriores' 'Outro emoji' 'webhook sync failed' 'MESSAGES_DELETE'; do
  grep -rqF -- "$s" web/src shared/src server/src || echo "FALTA: $s"
done
```
Expected: no `FALTA:` line. If one shows up, fix the doc wording to match the screen.

- [ ] **Step 4: Run the doc check again, then the whole suite**

Run (bash, repo root):
```bash
grep -c -e 'Apagar para todos' -e 'Enviar imagem como figurinha' -e 'MESSAGES_DELETE' docs/superpowers/plans/2026-10-16-acoes-mensagem-aceite.md
grep -c -e 'acoes-mensagem-aceite' docs/IMPLANTACAO.md
```
Expected: the first prints a number of at least `3`, the second prints `1`.

Run: `npm test` and `npm run typecheck`
Expected: every workspace passes and the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-16-acoes-mensagem-aceite.md docs/IMPLANTACAO.md
git commit -m "docs: manual acceptance script for message actions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
