# Scheduled Messages and Automatic Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent schedule a WhatsApp message (text, optionally one file) for a date and time in Cuiabá time, see and change the pending ones in the chat and on an "Agendamentos" page, and have a worker send it as the author at that time. Give admins two automatic rules, both off by default: "Devolver à fila conversas paradas" and "Finalizar por inatividade".

**Architecture:** Shared first: `shared/src/automation.ts` holds the office time zone helpers (Intl, no DST guess), the scheduling limits, `scheduleTimeProblem` (the same check on web and server) and the rule defaults. One migration (`0008`) adds `scheduled_messages` and `messages.scheduled`. The CRUD lives in `server/src/automation/scheduled.ts`. The routes are in `automation/routes.ts`, and the multipart reader is shared with the send route. Delivery (`automation/delivery.ts`) copies the bot scheduler's tick. It claims `pending → sending` under `FOR UPDATE SKIP LOCKED` in one transaction, then sends through the normal agent path: `startChat` picks the destination exactly like "Nova conversa", and `sendAgentMessage` runs as the author with `botAction: 'keep'`. It writes the outcome only while the row is still `sending`, and a row stuck in `sending` fails instead of going out again. Failures reach the author through a new `hub.notifyUser`, which skips the chat check, and the existing toast. The rules (`automation/rules.ts`) are two batched SELECTs. Each chat change goes through the existing `updateChat`, whose `WHERE` re-checks the condition, so a contact or an agent acting in between wins. One worker module runs the scheduled-message beat every 15 s and the rules beat every minute. The web adds a "Agendar mensagem" button and dialog in the composer, a "N mensagens agendadas" strip above it, an "Agendamentos" page, the "Agendada" mark on bubbles, the failure toast, and a "Regras automáticas" settings page.

**Tech Stack:** Node 24, TypeScript 5.9.3 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite 0.5.10 in tests), zod 4.6.7, vitest 5.0.4, React 19.3.1, @tanstack/react-query 5.104.2, react-router 8.4.0, Tailwind 4.3.3, @phosphor-icons/react 2.1.10. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-10-20-agendamentos-e-regras-design.md`.

**Base code.** This plan runs on `feat/agendamentos-e-regras`, which was created from `feat/lista-dia-a-dia` (delivery 2, PR #22). That base has migration `0007`, `chats.waiting_since`, `chat_tags`, the list orders, `server/src/inbox/bulk.ts` and `closeChatAndStopBots`. Every "replace X with Y" snippet below quotes that code verbatim. These files are shared with delivery 2, and the following must survive:
- `server/src/db/schema.ts`, `server/drizzle/meta/*`, `server/test/db/schema.test.ts`: `chatTags` and `chats.waitingSince`. There are 25 tables today; this plan makes 26.
- `server/src/messages/send.ts`: `waitingSince: null` in `touchChat`, and the dropped-echo restore of `waitingSince` in `sendSystemMessage`.
- `server/src/inbox/chats.ts`: `validateTransferTarget`, `setChatTags`, and `waitingSince: null` in `closeChat` and `closeChatAsBot`.
- `server/src/history/merge.ts`: `absorb` moving the chat tags.
- `server/src/chats/routes.ts`: the bulk routes, the tags route, `listQuery.sort` and `chatTagId`.
- `server/test/realtime/hub.test.ts` and `server/test/messages/dto.test.ts`: `favorite: null` in the expected objects.
- `web/src/lib/api.ts` (+ `api.test.ts`): `setTags`, `bulkTransfer`, `bulkClose` and `bulkRead`, plus the `describe('api routes of the 2026-10-20 delivery', …)` block.

If PR #22 changes before this plan runs, rebase onto the merged result and re-quote the snippets. Never regenerate `0007`.

## Global Constraints

- No new dependency in any workspace.
- Every read and mutation of a chat goes through `getChatForUser`, which answers 404 when the user cannot see the chat. `canSee` already covers private chats. A scheduled row can be edited or cancelled by its author or by any admin. Anyone else gets a 404, which reveals nothing.
- Every new mutation is a non-GET `/api/*` route, so the global Origin check (`authPlugin`) covers it. Tests send `loginAs(...).headers`. One test per route family sends no Origin and expects 403.
- Logs never carry message text, phones or names. Only ids, counts and `errorTag(err)` (from `server/src/bots/scheduler.ts`) go into a log. The scheduled row's `error` column and the toast do carry the pt-BR reason. That reason is a fixed string or the single action's HttpError message, never gateway text.
- The migration is generated, never hand-edited: `npm run db:generate -w server -- --name agendamentos_e_regras` creates `0008_agendamentos_e_regras`, right after `0007_lista_dia_a_dia`. The running dev server (`tsx watch`) applies it to its own database when it restarts. Never run SQL against that database by hand, and never start or stop the dev server, its database or Evolution.
- Extend, never rename. The new DTO fields are optional:
  - `MessageDto.scheduled?`, which `toMessageDto` always fills;
  - `NotificationDto.kind?`, where absent means a bot notification.
  Only the exact `MessageDto` literals in `hub.test.ts` and `dto.test.ts` gain `scheduled: false`.
- Inside `ctx.db.transaction(tx => …)` use only `tx`, because PGlite deadlocks otherwise. Publish to the hub after commit.
- The worker's clock is `ctx.botRuntime.now()`. In tests that is the fake clock (`ctx.clock`). Chat events are stamped with the DB's `clock_timestamp()`, so the rule tests set `ctx.clock.set(new Date())` first (see Task 5).
- Never send twice. The state machine is `pending → sending → sent | failed` plus `pending → canceled`. The claim and the `UPDATE … WHERE status = 'sending'` of the outcome are the only writers of a claimed row. A row in `sending` for more than `STUCK_MS` (10 min) becomes `failed` and is never sent again.
- `SendInput.storedFile` and `SendInput.scheduled` are set by the worker only. The send route builds `SendInput` from zod-parsed fields, so a body can never set them (Review Focus 6).
- Limits:
  - scheduled text: 1 to `SCHEDULE_TEXT_MAX` (4096) characters, required even with a file;
  - schedule time: at least `SCHEDULE_MIN_LEAD_MS` (2 min) and at most `SCHEDULE_MAX_AHEAD_MS` (365 days) ahead;
  - one file of up to 64 MB;
  - lists: `LIST_LIMIT = 100` rows;
  - delivery batch: 20;
  - rules batch: 50 per rule;
  - late delivery: `LATE_MS` (1 h);
  - rule 1 minutes: 5 to 1440 (default 30);
  - rule 2 hours: 1 to 720 (default 24).
- UI copy is pt-BR, exactly as spec §6:
  - composer: "Agendar mensagem", "Digite a mensagem que será agendada";
  - dialog: "Agendar mensagem" / "Editar agendamento", "Texto da mensagem", "Data e hora (horário de Cuiabá)", "Anexo: <arquivo>", "Agendar" / "Salvar" / "Cancelar";
  - strip and rows: "1 mensagem agendada" / "N mensagens agendadas", "por <nome>", "Anexo", "Editar", "Cancelar";
  - cancel confirmation: "Cancelar a mensagem agendada?" / "Cancelar agendamento";
  - bubble mark: "Agendada";
  - page: "Agendamentos", tabs "Pendentes" / "Enviadas" / "Falharam" / "Canceladas", statuses "Pendente" / "Enviando…" / "Enviada" / "Falhou" / "Cancelada", empty state "Nenhuma mensagem aqui.";
  - toast: "Mensagem agendada não enviada", footer "Mensagens agendadas";
  - events: "Mensagem agendada por X para D", "Mensagem agendada alterada por X para D", "Mensagem agendada cancelada por X", "Devolvida à fila: sem resposta há N min", "Finalizada por inatividade";
  - settings: "Regras automáticas", "Devolver à fila conversas paradas", "Minutos sem resposta", "Finalizar por inatividade", "Horas sem mensagens", "Enviar a mensagem de encerramento", "Salvar", "Regras salvas.".
- Code identifiers are English.
- Theme tokens only (`bg-surface`, `bg-panel`, `bg-sunken`, `bg-sidebar-hover`, `bg-primary-soft`, `text-fg`, `text-muted`, `text-link`, `text-danger`, `text-success`, `border-border`, `border-field`, `divide-border`).
- Reuse what exists:
  - `Modal`, `Actions` (`ChatDialogs.tsx`), `confirmDialog`, `errorMessage`, `contactLabel`;
  - `Section` / `field` / `btnPrimary` / `useSend` / `Loading` / `ErrorText` (`components/settings/common.tsx`);
  - `startChat`, `sendAgentMessage`, `sendSystemMessage`, `getClosingMessage`, `updateChat`;
  - `errorTag`, `loadAuthUser`, `saveMedia`, `addEvent`;
  - the test seeds `seedChat`, `eventsOf`, `multipart`.
- Commit after every task with a Conventional Commit message, staging only that task's files. Every commit command ends with `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

## Review Focus

These are inputs and conditions the spec implies but never tests, most likely first. The owning task adds the named test.

1. **Two beats or a retry sending one message twice.** A tick that overlaps another (two processes, or a slow beat) must claim each row once. A row whose send was interrupted must fail, not go out again. **Owner: Task 3**, tests `two beats at the same time still send it once (Review Focus 1)` and `a row stuck in 'sending' for more than 10 minutes fails and is never sent again (Review Focus 1)`.
2. **Where a scheduled message lands when its chat moved on.** The chat may be closed, or the contact may have an open chat in a sector the author no longer sees. The send must follow "Nova conversa" exactly and must never write into a chat the author cannot see. **Owner: Task 3**, tests `a closed chat: opens a new chat in the original sector with the author as owner, like "Nova conversa" (Review Focus 2)` and `an open chat the author cannot see: fails with the reason, sends nothing and tells only the author (Review Focus 2)`.
3. **"Devolver à fila" firing right after someone took the chat, or looping.** A chat that waited 2 h and was just assumed must get N minutes. A chat that was already returned must not be touched again. **Owner: Task 5**, tests `the count starts again when someone takes the chat (Review Focus 3)` and `takes the owner away … once, and says why`.
4. **"Finalizar por inatividade" closing a chat the contact just wrote to, or spamming the closing message.** A message that arrives while the closing message is going out must keep the chat open. A failed closing message must not be retried every minute. **Owner: Task 5**, tests `a contact writing while the closing message goes out keeps the chat open (Review Focus 4)` and `a failed closing message keeps the chat open and the next beat leaves it alone (Review Focus 4)`.
5. **Cuiabá time in a browser set to another zone.** `datetime-local` gives wall time in no zone. The conversion must not use the browser's zone. **Owner: Task 1**, test `reads a datetime-local value as Cuiabá time and back`. **Task 7**, test `reads the time as Cuiabá time, refuses less than 2 minutes ahead and hands back an ISO instant`.
6. **The worker-only send fields reached from the API.** `storedFile.path` would let a body send any file under (or outside) `mediaDir`. **Owner: Task 3**, test `the send route never takes storedFile or scheduled from the body (Review Focus 6)`.
7. **A chat that still has a pending scheduled message being closed for inactivity.** **Owner: Task 5**, test `leaves waiting, chatbot and scheduled chats alone, and closes private ones`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Shared**
- `shared/src/automation.ts` (T1, create): `OFFICE_TIMEZONE`, the schedule limits, `SCHEDULED_STATUSES`, `SCHEDULED_TABS`, `scheduleTimeProblem`, `officeLocalToIso`, `isoToOfficeLocal`, `formatOfficeDateTime`, `AutoRulesDto`, `DEFAULT_AUTO_RULES`, `RETURN_TO_QUEUE_MINUTES`, `CLOSE_INACTIVE_HOURS`.
- `shared/src/index.ts` (T1): re-exports, `MessageDto.scheduled?`, the new `ChatEventKind`s, `ScheduledMessageDto`.
- `shared/src/bots.ts` (T1): `NotificationDto.kind?`.

**Server**
- `server/src/db/schema.ts` (T1): `messages.scheduled`, table `scheduledMessages`.
- `server/drizzle/0008_agendamentos_e_regras.sql`, `server/drizzle/meta/0008_snapshot.json`, `server/drizzle/meta/_journal.json` (T1): the generated migration.
- `server/src/chats/routes.ts` (T2): `readParts` exported (the multipart reader without the "file required" rule).
- `server/src/automation/scheduled.ts` (T2, create): `createScheduled`, `listChatScheduled`, `listScheduled`, `updateScheduled`, `cancelScheduled`, `NOT_PENDING`, `OPEN_STATUSES`.
- `server/src/automation/routes.ts` (T2, create): the five scheduled-message routes.
- `server/src/app.ts` (T2): registers them.
- `server/src/history/merge.ts` (T2): `absorb` moves the scheduled rows.
- `server/src/messages/send.ts` (T3): `SendInput.storedFile?` and `SendInput.scheduled?`.
- `server/src/messages/dto.ts` (T3): `scheduled`.
- `server/src/realtime/hub.ts` (T3): `notifyUser`.
- `server/src/automation/delivery.ts` (T3, create): `deliverDueScheduled`, `failStuckScheduled`, `FAIL`, `LATE_MS`, `STUCK_MS`.
- `server/src/catalog/settings.ts` (T4): `getAutoRules`, `GET`/`PUT /api/settings/auto-rules`.
- `server/src/inbox/chats.ts` (T5): `returnChatToQueue`, `closeChatForInactivity`.
- `server/src/automation/rules.ts` (T5, create): `runAutoRules`.
- `server/src/automation/worker.ts` (T5, create): `createAutomationWorker`.
- `server/src/index.ts` (T5): starts and stops the worker.

**Server tests**
- `server/test/db/schema.test.ts` (T1).
- `server/test/automation/office-time.test.ts` (T1, create).
- `server/test/automation/seed.ts` (T2, create): `insertScheduled`, `runningBot`.
- `server/test/automation/scheduled-api.test.ts` (T2, create).
- `server/test/history/merge.test.ts` (T2).
- `server/test/automation/delivery.test.ts` (T3, create).
- `server/test/messages/dto.test.ts`, `server/test/realtime/hub.test.ts` (T3).
- `server/test/catalog/settings.test.ts` (T4).
- `server/test/automation/rules.test.ts` (T5, create).

**Web**
- `web/src/components/conversation/model.ts` (+ `model.test.ts`) (T1): `eventText` for the new events.
- `web/src/lib/api.ts` (+ `api.test.ts`) (T6): `ScheduleInput`, `api.scheduled.*`, `api.settings.autoRules.*`, `qk.scheduled`, `qk.chatScheduled`, `qk.scheduledList`, `qk.autoRules`.
- `web/src/components/layout/NotificationToasts.tsx` (+ test) (T6): the `scheduled_failed` toast.
- `web/src/components/conversation/MessageBubble.tsx` (+ test) (T6): the "Agendada" mark.
- `web/src/components/conversation/Scheduled.tsx` (+ `Scheduled.test.tsx`) (T7, create): `ScheduleDialog`, `ScheduledItem`, `ScheduledStrip`, `scheduledCount`, `STATUS_LABELS`.
- `web/src/components/conversation/Composer.tsx` (+ `Composer.test.tsx`) (T7): the "Agendar mensagem" button.
- `web/src/components/conversation/ConversationView.tsx` (T7): the strip, refreshed on `chat.updated`.
- `web/src/pages/ScheduledMessages.tsx` (+ `ScheduledMessages.test.tsx`) (T8, create): the "Agendamentos" page.
- `web/src/App.tsx`, `web/src/components/layout/AppLayout.tsx` (T8): the route and the menu item.
- `web/src/pages/settings/AutoRulesSettings.tsx` (+ test) (T9, create), `web/src/pages/settings/SettingsPage.tsx` (T9).

---

## Shared contract

Every name below is defined in exactly one task and used with this spelling everywhere.

**`shared/src/automation.ts` (Task 1)**
```ts
export const OFFICE_TIMEZONE = 'America/Cuiaba';
export const SCHEDULE_MIN_LEAD_MS: number;   // 2 min
export const SCHEDULE_MAX_AHEAD_MS: number;  // 365 days
export const SCHEDULE_TEXT_MAX: number;      // 4096
export const SCHEDULED_STATUSES: readonly ['pending', 'sending', 'sent', 'failed', 'canceled'];
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];
export const SCHEDULED_TABS: readonly ['pending', 'sent', 'failed', 'canceled'];
export type ScheduledTab = (typeof SCHEDULED_TABS)[number];
export function scheduleTimeProblem(sendAt: Date | null, now: Date): string | null;
export function officeLocalToIso(local: string): string | null;   // 'YYYY-MM-DDTHH:mm' in Cuiabá → ISO
export function isoToOfficeLocal(iso: string): string;            // ISO → 'YYYY-MM-DDTHH:mm' in Cuiabá
export function formatOfficeDateTime(iso: string): string;        // 'dd/mm/aaaa hh:mm' in Cuiabá
export const RETURN_TO_QUEUE_MINUTES: { min: 5; max: 1440 };
export const CLOSE_INACTIVE_HOURS: { min: 1; max: 720 };
export interface AutoRulesDto { returnToQueue: { enabled: boolean; minutes: number }; closeInactive: { enabled: boolean; hours: number; sendClosingMessage: boolean } }
export const DEFAULT_AUTO_RULES: AutoRulesDto; // both off; 30 min; 24 h; closing message on
```

**`shared/src/index.ts` and `bots.ts` (Task 1)**
```ts
// MessageDto gains (optional): scheduled?: boolean
// NotificationDto gains (optional): kind?: 'bot' | 'scheduled_failed'
// ChatEventKind gains: 'message_scheduled' (data { scheduledId, sendAt, edited? }) | 'scheduled_canceled' (data { scheduledId })
//                      | 'returned_to_queue' (data { minutes, previousOwnerId }); inactivity close = 'closed' with data.reason 'inactivity'
export interface ScheduledMessageDto {
  id: string; chatId: string; contact: { id: string; name: string | null; phone: string | null };
  authorId: string; authorName: string; body: string; signature: boolean;
  attachment: { name: string; mime: string; size: number } | null;
  sendAt: string; status: ScheduledStatus; error: string | null; messageId: string | null; sentChatId: string | null;
  createdAt: string; finishedAt: string | null; canEdit: boolean;
}
```

**`server/src/db/schema.ts` (Task 1)**: `messages.scheduled` (`boolean not null default false`); table `scheduledMessages`:
- `chatId` → chats, cascade;
- `authorId` → users;
- `body`, `signature`;
- `mediaPath`, `mediaMime`, `mediaName`, `mediaSize`, `mediaSha256`;
- `sendAt`, `status`, `claimedAt`, `finishedAt`;
- `messageId` → messages, set null;
- `error`, `createdAt`;
- indexes `scheduled_messages_due_idx (status, send_at)` and `scheduled_messages_chat_idx (chat_id)`.

**Server**
```ts
// server/src/chats/routes.ts (Task 2)
export async function readParts(req: FastifyRequest): Promise<{ fields: Record<string, string>; file?: SendInput['file'] }>;
// server/src/automation/scheduled.ts (Task 2)
export const NOT_PENDING: string; export const OPEN_STATUSES: ScheduledStatus[]; // ['pending', 'sending']
export interface ScheduleInput { text: string; sendAt: Date; signature: boolean; file?: { buffer: Buffer; mime: string; name: string } }
export async function createScheduled(ctx: AppCtx, user: AuthUser, chatId: string, input: ScheduleInput): Promise<ScheduledMessageDto>;
export async function listChatScheduled(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ScheduledMessageDto[]>;
export async function listScheduled(ctx: AppCtx, user: AuthUser, tab: ScheduledTab): Promise<ScheduledMessageDto[]>;
export async function updateScheduled(ctx: AppCtx, user: AuthUser, id: string, patch: { text?: string; sendAt?: Date }): Promise<ScheduledMessageDto>;
export async function cancelScheduled(ctx: AppCtx, user: AuthUser, id: string): Promise<ScheduledMessageDto>;
// server/src/messages/send.ts (Task 3): SendInput gains storedFile?: { path; mime; name; size; sha256 | null } and scheduled?: boolean
// server/src/realtime/hub.ts (Task 3): Hub gains notifyUser(userId: string, notification: NotificationDto): void
// server/src/automation/delivery.ts (Task 3)
export const LATE_MS: number; export const STUCK_MS: number; export const FAIL: { late; authorInactive; noAccess; refused; stuck; unexpected };
export async function failStuckScheduled(ctx: AppCtx, now: Date): Promise<number>;
export async function deliverDueScheduled(ctx: AppCtx, now?: Date): Promise<number>;
// server/src/catalog/settings.ts (Task 4)
export async function getAutoRules(db: Db | Tx): Promise<AutoRulesDto>;
// server/src/inbox/chats.ts (Task 5)
export async function returnChatToQueue(ctx: AppCtx, chatId: string, ownerId: string, minutes: number): Promise<boolean>;
export async function closeChatForInactivity(ctx: AppCtx, chatId: string, opts: { closingText: string | null; hours: number }): Promise<boolean>;
// server/src/automation/rules.ts (Task 5)
export async function runAutoRules(ctx: AppCtx, now?: Date): Promise<{ returned: number; closed: number }>;
// server/src/automation/worker.ts (Task 5)
export function createAutomationWorker(ctx: AppCtx, opts?: { scheduledMs?: number; rulesMs?: number }): { start(): void; stop(): void };
```

**HTTP**
| Route | Body / query | Answer | Task |
|---|---|---|---|
| `POST /api/chats/:id/scheduled-messages` | JSON `{ text, sendAt, signature }` or multipart (same fields, then `file`) | `ScheduledMessageDto` | 2 |
| `GET /api/chats/:id/scheduled-messages` | | `ScheduledMessageDto[]` (pending and sending, next first) | 2 |
| `GET /api/scheduled-messages` | `status` (`SCHEDULED_TABS`, default `pending`) | `ScheduledMessageDto[]` (mine; admin: all) | 2 |
| `PATCH /api/scheduled-messages/:id` | `{ text?, sendAt? }` (at least one) | `ScheduledMessageDto` | 2 |
| `POST /api/scheduled-messages/:id/cancel` | | `ScheduledMessageDto` | 2 |
| `GET /api/settings/auto-rules` | (admin) | `AutoRulesDto` | 4 |
| `PUT /api/settings/auto-rules` | `AutoRulesDto` (admin) | `AutoRulesDto` | 4 |

`sendAt` is an ISO date-time with an offset (`z.iso.datetime({ offset: true })`).

**Web**
- `web/src/lib/api.ts` (Task 6):
  - `ScheduleInput { text; sendAt; signature; file?; fileName? }`;
  - `api.scheduled.listForChat(chatId)`, `list(tab)`, `create(chatId, input)`, `update(id, patch)`, `cancel(id)`;
  - `api.settings.autoRules.get()`, `put(rules)`;
  - query keys `qk.scheduled` (prefix `['chats', 'scheduled']`), `qk.chatScheduled(chatId)`, `qk.scheduledList(tab)` and `qk.autoRules` (`['settings', 'auto-rules']`).
- `web/src/components/conversation/Scheduled.tsx` (Task 7):
  - `ScheduleDialog({ title, confirmLabel, initialText, initialSendAt?, fileName?, onCancel, onConfirm(text, sendAt | undefined) })`, where `sendAt` is undefined only for an edit that kept the time;
  - `ScheduledItem({ item, page? })`;
  - `ScheduledStrip({ chatId })`;
  - `scheduledCount(n)` and `STATUS_LABELS`.
- `web/src/pages/ScheduledMessages.tsx` (Task 8): `ScheduledMessagesPage`.
- `web/src/pages/settings/AutoRulesSettings.tsx` (Task 9): `AutoRulesSettings`.

---

### Task 1: Shared contract, `scheduled_messages`, `messages.scheduled` and migration 0008

Nothing reads the new tables yet. This task has to compile, migrate, convert Cuiabá time correctly, and describe the new events. The new `ChatEventKind`s force `eventText`'s exhaustive switch to change in this task too, or the web typecheck fails.

**Files:**
- Create: `shared/src/automation.ts`
- Modify: `shared/src/index.ts` (imports and re-exports, `MessageDto`, `ChatEventKind`, new `ScheduledMessageDto`)
- Modify: `shared/src/bots.ts` (`NotificationDto`)
- Modify: `server/src/db/schema.ts` (`@talk/shared` import, `messages`, new table after `messageFavorites`)
- Generated: `server/drizzle/0008_agendamentos_e_regras.sql`, `server/drizzle/meta/0008_snapshot.json`, `server/drizzle/meta/_journal.json`
- Modify: `web/src/components/conversation/model.ts` (`@talk/shared` import, `eventText`)
- Test: `server/test/db/schema.test.ts`, `server/test/automation/office-time.test.ts` (create), `web/src/components/conversation/model.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: everything under `shared/src/automation.ts`, `shared/src/index.ts`, `bots.ts` and `server/src/db/schema.ts` in the Shared contract.

- [ ] **Step 1: Write the failing tests**

Create `server/test/automation/office-time.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_MAX_AHEAD_MS, formatOfficeDateTime, isoToOfficeLocal, officeLocalToIso, scheduleTimeProblem,
} from '@talk/shared';

describe('office time, America/Cuiaba (spec 2026-10-20 agendamentos §2)', () => {
  it('reads a datetime-local value as Cuiabá time and back (Review Focus 5)', () => {
    expect(officeLocalToIso('2026-10-20T14:30')).toBe('2026-10-20T18:30:00.000Z');
    expect(officeLocalToIso('2026-12-31T23:59')).toBe('2027-01-01T03:59:00.000Z');
    expect(isoToOfficeLocal('2026-10-20T18:30:45.000Z')).toBe('2026-10-20T14:30');
    expect(isoToOfficeLocal('2027-01-01T03:59:00.000Z')).toBe('2026-12-31T23:59');
    expect(officeLocalToIso('20/10/2026 14:30')).toBeNull();
    expect(officeLocalToIso('')).toBeNull();
    expect(formatOfficeDateTime('2026-10-21T03:05:00.000Z')).toBe('20/10/2026 23:05');
  });

  it('accepts from 2 minutes to 1 year ahead (spec §3.1)', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    expect(scheduleTimeProblem(null, now)).toBe('Escolha a data e a hora');
    expect(scheduleTimeProblem(new Date('nope'), now)).toBe('Escolha a data e a hora');
    expect(scheduleTimeProblem(new Date('2026-10-20T12:01:59.000Z'), now)).toBe('Escolha um horário pelo menos 2 minutos à frente');
    expect(scheduleTimeProblem(new Date('2026-10-20T12:02:00.000Z'), now)).toBeNull();
    expect(scheduleTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS), now)).toBeNull();
    expect(scheduleTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS + 60_000), now)).toBe('Escolha um horário em até 1 ano');
  });
});
```

In `server/test/db/schema.test.ts`, replace

```ts
import {
  botRuns, botVersions, bots, chatTags, chats, contacts, historyImports, messageEdits, messageFavorites, messages, sectors, tags,
} from '../../src/db/schema.js';
```

with

```ts
import {
  botRuns, botVersions, bots, chatTags, chats, contacts, historyImports, messageEdits, messageFavorites, messages, scheduledMessages,
  sectors, tags,
} from '../../src/db/schema.js';
```

replace `expect(tables).toHaveLength(25);` with `expect(tables).toHaveLength(26);`. Then add this test at the end of the first `describe('database schema', …)`, after the `chat_tags` test:

```ts
  it('scheduled_messages: pending by default, gone with the chat; messages.scheduled starts false (spec 2026-10-20 agendamentos)', async () => {
    const [c] = await db.insert(contacts).values({ phone: '5565999990004' }).returning({ id: contacts.id });
    const [chat] = await db
      .insert(chats)
      .values({ contactId: c!.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning({ id: chats.id });
    const [m] = await db
      .insert(messages)
      .values({ chatId: chat!.id, channelId: s.channelId, direction: 'out', kind: 'text', body: 'oi', status: 'sent', sentAt: new Date() })
      .returning();
    expect(m!.scheduled).toBe(false);
    const [row] = await db
      .insert(scheduledMessages)
      .values({ chatId: chat!.id, authorId: s.agentA.id, body: 'Lembrete', signature: true, sendAt: new Date(), messageId: m!.id })
      .returning();
    expect(row).toMatchObject({ status: 'pending', claimedAt: null, finishedAt: null, error: null, mediaPath: null });

    await db.delete(messages).where(eq(messages.id, m!.id));
    expect((await db.select().from(scheduledMessages))[0]!.messageId).toBeNull();
    await db.delete(chats).where(eq(chats.id, chat!.id));
    expect(await db.select().from(scheduledMessages)).toEqual([]);
  });
```

In `web/src/components/conversation/model.test.ts`, add after the `describe('eventText for history events', …)` block:

```ts
describe('eventText for scheduled messages and automatic rules (spec 2026-10-20 agendamentos)', () => {
  it('describes each new kind in Portuguese, dates in Cuiabá time', () => {
    const sendAt = '2026-10-21T12:00:00.000Z'; // 08:00 in Cuiabá
    expect(eventText(event({ kind: 'message_scheduled', authorName: 'Bia', data: { scheduledId: 's1', sendAt } }), new Map())).toBe(
      'Mensagem agendada por Bia para 21/10/2026 08:00',
    );
    expect(
      eventText(event({ kind: 'message_scheduled', authorName: 'Bia', data: { scheduledId: 's1', sendAt, edited: true } }), new Map()),
    ).toBe('Mensagem agendada alterada por Bia para 21/10/2026 08:00');
    expect(eventText(event({ kind: 'scheduled_canceled', authorName: 'Bia', data: { scheduledId: 's1' } }), new Map())).toBe(
      'Mensagem agendada cancelada por Bia',
    );
    expect(eventText(event({ kind: 'returned_to_queue', data: { minutes: 30, previousOwnerId: 'u-ana' } }), new Map())).toBe(
      'Devolvida à fila: sem resposta há 30 min',
    );
    expect(eventText(event({ kind: 'closed', data: { closingMessageSent: true, reason: 'inactivity', hours: 24 } }), new Map())).toBe(
      'Finalizada por inatividade',
    );
    expect(eventText(event({ kind: 'closed', authorName: 'Bia' }), new Map())).toBe('Conversa finalizada por Bia');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/automation/office-time.test.ts test/db/schema.test.ts`
Expected: FAIL. `officeLocalToIso` is not exported by `@talk/shared`, `scheduledMessages` is not exported by `schema.js`, and the table count is off by one.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL on the new test, because `eventText` returns `undefined` for the new kinds and "Conversa finalizada" for the inactivity close.

- [ ] **Step 3: Create the shared module**

Create `shared/src/automation.ts`:

```ts
// Scheduled messages and automatic rules (spec 2026-10-20 agendamentos §2–§4). Runtime values with no imports: tsx
// (server) and Vite (web) load this source directly.

/** Every scheduled time is typed and shown in the office's zone, whatever the computer's zone is (spec §2). */
export const OFFICE_TIMEZONE = 'America/Cuiaba';
export const SCHEDULE_MIN_LEAD_MS = 2 * 60_000;
export const SCHEDULE_MAX_AHEAD_MS = 365 * 24 * 60 * 60_000;
export const SCHEDULE_TEXT_MAX = 4096;

export const SCHEDULED_STATUSES = ['pending', 'sending', 'sent', 'failed', 'canceled'] as const;
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];
/** The "Agendamentos" tabs; 'pending' also lists the rows being sent right now. */
export const SCHEDULED_TABS = ['pending', 'sent', 'failed', 'canceled'] as const;
export type ScheduledTab = (typeof SCHEDULED_TABS)[number];

/** The pt-BR reason a time cannot be scheduled, or null. The web and the server run this same check (spec §3.1). */
export function scheduleTimeProblem(sendAt: Date | null, now: Date): string | null {
  if (!sendAt || Number.isNaN(sendAt.getTime())) return 'Escolha a data e a hora';
  if (sendAt.getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) return 'Escolha um horário pelo menos 2 minutos à frente';
  if (sendAt.getTime() > now.getTime() + SCHEDULE_MAX_AHEAD_MS) return 'Escolha um horário em até 1 ano';
  return null;
}

const WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: OFFICE_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const wallParts = (d: Date) => Object.fromEntries(WALL.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;

/** Office wall time minus UTC at `d`, in ms (Cuiabá today: -4 h). Read from Intl, so no DST rule is assumed either way. */
function offsetMs(d: Date): number {
  const p = wallParts(d);
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return wall - (d.getTime() - (d.getTime() % 60_000));
}

/** A datetime-local value ('YYYY-MM-DDTHH:mm') read as office time → ISO instant; null when malformed. */
export function officeLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // guess with the offset at that instant, then once more with the offset at the guess (only differs on a DST edge)
  const guess = asUtc - offsetMs(new Date(asUtc));
  return new Date(asUtc - offsetMs(new Date(guess))).toISOString();
}

/** ISO instant → a datetime-local value ('YYYY-MM-DDTHH:mm') in office time. */
export function isoToOfficeLocal(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() + offsetMs(d)).toISOString().slice(0, 16);
}

/** "20/10/2026 14:30" in office time. */
export function formatOfficeDateTime(iso: string): string {
  const p = wallParts(new Date(iso));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Spec §4: Configurações → "Regras automáticas" (settings key 'auto_rules'). */
export const RETURN_TO_QUEUE_MINUTES = { min: 5, max: 1440 } as const;
export const CLOSE_INACTIVE_HOURS = { min: 1, max: 720 } as const;
export interface AutoRulesDto {
  returnToQueue: { enabled: boolean; minutes: number };
  closeInactive: { enabled: boolean; hours: number; sendClosingMessage: boolean };
}
/** Both off until an admin turns them on. */
export const DEFAULT_AUTO_RULES: AutoRulesDto = {
  returnToQueue: { enabled: false, minutes: 30 },
  closeInactive: { enabled: false, hours: 24, sendClosingMessage: true },
};
```

- [ ] **Step 4: Export it and extend the DTOs**

In `shared/src/index.ts`, after `import type { ChatSort } from './chat-list.js';`, add:

```ts
import type { ScheduledStatus } from './automation.js';
```

After `export type * from './chat-list.js';`, add:

```ts
export {
  OFFICE_TIMEZONE, SCHEDULE_MIN_LEAD_MS, SCHEDULE_MAX_AHEAD_MS, SCHEDULE_TEXT_MAX, SCHEDULED_STATUSES, SCHEDULED_TABS,
  RETURN_TO_QUEUE_MINUTES, CLOSE_INACTIVE_HOURS, DEFAULT_AUTO_RULES, scheduleTimeProblem, officeLocalToIso, isoToOfficeLocal,
  formatOfficeDateTime,
} from './automation.js';
export type * from './automation.js';
```

In `MessageDto`, replace

```ts
  // the team's shared star (spec 2026-10-19 §5), optional for the same reason; toMessageDto always fills it (Task 2)
  favorite?: { at: string; byName: string | null } | null }
```

with

```ts
  // the team's shared star (spec 2026-10-19 §5), optional for the same reason; toMessageDto always fills it (Task 2)
  favorite?: { at: string; byName: string | null } | null;
  // sent by the scheduled-message worker: the "Agendada" mark (spec 2026-10-20 agendamentos §3.3); toMessageDto always fills it
  scheduled?: boolean }
```

Replace

```ts
  | 'note_deleted'; // data: {} (spec 2026-10-19 §3); the event author is who deleted the note
```

with

```ts
  | 'note_deleted' // data: {} (spec 2026-10-19 §3); the event author is who deleted the note
  // spec 2026-10-20 agendamentos: data { scheduledId, sendAt, edited? } | { scheduledId } | { minutes, previousOwnerId }.
  // The inactivity close is a 'closed' event with data.reason 'inactivity' and no author.
  | 'message_scheduled' | 'scheduled_canceled' | 'returned_to_queue';
```

After the `SettingsDto` interface, add:

```ts
/** Spec 2026-10-20 agendamentos §3. `chatId` = the chat it was scheduled in; `sentChatId` = where it went (a new chat when that one was closed). */
export interface ScheduledMessageDto { id: string; chatId: string; contact: { id: string; name: string | null; phone: string | null };
  authorId: string; authorName: string; body: string; signature: boolean; attachment: { name: string; mime: string; size: number } | null;
  sendAt: string; status: ScheduledStatus; error: string | null; messageId: string | null; sentChatId: string | null;
  createdAt: string; finishedAt: string | null;
  // the author or an admin, while still pending
  canEdit: boolean }
```

In `shared/src/bots.ts`, replace

```ts
export interface NotificationDto { id: string; chatId: string; title: string; text: string; botName: string; createdAt: string }
```

with

```ts
export interface NotificationDto { id: string; chatId: string; title: string; text: string; botName: string; createdAt: string;
  // spec 2026-10-20 agendamentos §3.3: a failed scheduled message (botName ''); absent = 'bot'
  kind?: 'bot' | 'scheduled_failed' }
```

- [ ] **Step 5: Add the column and the table**

In `server/src/db/schema.ts`, replace

```ts
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
  UserPreferences,
} from '@talk/shared';
```

with

```ts
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
  ScheduledStatus, UserPreferences,
} from '@talk/shared';
```

In `messages`, after the `mediaStatus: …` line, add:

```ts
    scheduled: boolean('scheduled').notNull().default(false), // spec 2026-10-20 agendamentos §3.3: sent by the scheduled-message worker
```

After the `messageFavorites` table, add:

```ts
/**
 * Spec 2026-10-20 agendamentos §3: a message to send later as `author_id`. pending → sending (claimed) → sent | failed,
 * or pending → canceled. The file is saved when it is scheduled; `message_id` is the message it became.
 */
export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    signature: boolean('signature').notNull(),
    mediaPath: text('media_path'), // relative to config.mediaDir
    mediaMime: text('media_mime'),
    mediaName: text('media_name'),
    mediaSize: integer('media_size'),
    mediaSha256: text('media_sha256'),
    sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
    status: text('status').$type<ScheduledStatus>().notNull().default('pending'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }), // when it went 'sending'
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    error: text('error'), // pt-BR reason of a failure (never gateway text)
    createdAt: createdAt(),
  },
  (t) => [index('scheduled_messages_due_idx').on(t.status, t.sendAt), index('scheduled_messages_chat_idx').on(t.chatId)],
);
```

- [ ] **Step 6: Generate the migration**

Run: `npm run db:generate -w server -- --name agendamentos_e_regras`
Expected: it creates `server/drizzle/0008_agendamentos_e_regras.sql` and `server/drizzle/meta/0008_snapshot.json`, and it adds the `0008_agendamentos_e_regras` entry (idx 8) to `_journal.json` after `0007_lista_dia_a_dia`.

Run: `grep -E '^(CREATE|ALTER|DROP)' server/drizzle/0008_agendamentos_e_regras.sql`
Expected: exactly 7 lines:
- `CREATE TABLE "scheduled_messages" (`;
- `ALTER TABLE "messages" ADD COLUMN "scheduled" boolean DEFAULT false NOT NULL;…`;
- three `ALTER TABLE "scheduled_messages" ADD CONSTRAINT … FOREIGN KEY …` lines (chat cascade, author no action, message set null);
- two `CREATE INDEX "scheduled_messages_…_idx" …` lines.

Anything else means the schema and the 0007 snapshot disagree. For example, a `chat_tags` or `waiting_since` statement. In that case stop: do not edit the SQL or the snapshot, and report it.

- [ ] **Step 7: Describe the new events on the web**

In `web/src/components/conversation/model.ts`, replace

```ts
import { SEARCH_LIMIT, type ChatEventDto, type MessageDto, type TimelineItem } from '@talk/shared';
```

with

```ts
import { SEARCH_LIMIT, formatOfficeDateTime, type ChatEventDto, type MessageDto, type TimelineItem } from '@talk/shared';
```

replace

```ts
    case 'closed':
      return `Conversa finalizada${by}${viaBot}`;
```

with

```ts
    case 'closed':
      return e.data.reason === 'inactivity' ? 'Finalizada por inatividade' : `Conversa finalizada${by}${viaBot}`;
```

and replace

```ts
    case 'note_deleted':
      return `Nota apagada${by}`;
  }
```

with

```ts
    case 'note_deleted':
      return `Nota apagada${by}`;
    case 'message_scheduled': {
      const when = typeof e.data.sendAt === 'string' ? ` para ${formatOfficeDateTime(e.data.sendAt)}` : '';
      return `Mensagem agendada${e.data.edited === true ? ' alterada' : ''}${by}${when}`;
    }
    case 'scheduled_canceled':
      return `Mensagem agendada cancelada${by}`;
    case 'returned_to_queue':
      return `Devolvida à fila: sem resposta há ${Number(e.data.minutes ?? 0)} min`;
  }
```

- [ ] **Step 8: Run the tests and the type check**

Run: `npm test -w server -- test/automation/office-time.test.ts test/db/schema.test.ts`
Expected: PASS.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors in any workspace.

- [ ] **Step 9: Commit**

```bash
git add shared/src/automation.ts shared/src/index.ts shared/src/bots.ts server/src/db/schema.ts server/drizzle/0008_agendamentos_e_regras.sql server/drizzle/meta/0008_snapshot.json server/drizzle/meta/_journal.json server/test/db/schema.test.ts server/test/automation/office-time.test.ts web/src/components/conversation/model.ts web/src/components/conversation/model.test.ts
git commit -m "feat(shared,server): office time helpers, scheduled_messages and messages.scheduled (migration 0008)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schedule, list, edit and cancel (API)

This task covers the CRUD only; nothing is sent yet. The multipart loop of the send route moves into `readParts`, so the scheduled route reads the same 64 MB, one-file body. The "file required" rule stays in `readMultipart`.

**Files:**
- Modify: `server/src/chats/routes.ts` (`readMultipart` split into `readParts` + `readMultipart`)
- Create: `server/src/automation/scheduled.ts`, `server/src/automation/routes.ts`
- Modify: `server/src/app.ts` (import, registration after `chatRoutes`)
- Modify: `server/src/history/merge.ts` (`absorb`, import)
- Create: `server/test/automation/seed.ts`
- Test: `server/test/automation/scheduled-api.test.ts` (create), `server/test/history/merge.test.ts`

**Interfaces:**
- Consumes: Task 1 `scheduledMessages`, `scheduleTimeProblem`, `SCHEDULE_TEXT_MAX`, `SCHEDULED_TABS`, `ScheduledMessageDto`, the `message_scheduled` / `scheduled_canceled` event kinds.
- Produces: `readParts`, `createScheduled`, `listChatScheduled`, `listScheduled`, `updateScheduled`, `cancelScheduled`, `NOT_PENDING`, `OPEN_STATUSES`, the five HTTP routes; test seeds `insertScheduled(ctx, values)` and `runningBot(ctx, chatId, contactId)` (used by Tasks 3 and 5).

- [ ] **Step 1: Write the test seeds**

Create `server/test/automation/seed.ts`:

```ts
import type { AppCtx } from '../../src/ctx.js';
import { botRuns, botVersions, bots, scheduledMessages } from '../../src/db/schema.js';

type ScheduledInsert = typeof scheduledMessages.$inferInsert;

/** A scheduled-message row written directly (no route, no event). */
export async function insertScheduled(
  ctx: AppCtx,
  values: Pick<ScheduledInsert, 'chatId' | 'authorId' | 'sendAt'> & Partial<ScheduledInsert>,
): Promise<typeof scheduledMessages.$inferSelect> {
  const [row] = await ctx.db
    .insert(scheduledMessages)
    .values({ body: 'Lembrete: audiência amanhã às 9h', signature: false, ...values })
    .returning();
  return row!;
}

let seq = 0;
/** A chatbot run waiting for the contact's reply: a "running bot" for spec §3.3 and §4. */
export async function runningBot(ctx: AppCtx, chatId: string, contactId: string): Promise<string> {
  seq += 1;
  const [bot] = await ctx.db.insert(bots).values({ name: `Recepção ${seq}` }).returning();
  const [version] = await ctx.db
    .insert(botVersions)
    .values({ botId: bot!.id, number: 1, graph: { nodes: [], edges: [] }, valid: true })
    .returning();
  const [run] = await ctx.db
    .insert(botRuns)
    .values({ botId: bot!.id, versionId: version!.id, chatId, contactId, state: 'waiting_reply', currentNodeId: 'n1' })
    .returning();
  return run!.id;
}
```

- [ ] **Step 2: Write the failing tests**

Create `server/test/automation/scheduled-api.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledMessageDto } from '@talk/shared';
import { NOT_PENDING } from '../../src/automation/scheduled.js';
import { scheduledMessages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { multipart } from '../messages/actions-seed.js';
import { insertScheduled } from './seed.js';

const MIN = 60_000;

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let ana: Record<string, string>;
let chatId: string;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ana = (await loginAs(app, s.agentA.email)).headers;
  ({ chatId } = await seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, name: 'Maria Cliente', phone: '5565999999999',
  }));
});
afterEach(async () => {
  await app.close();
});

/** `n` minutes after the fake clock (the server checks the limits against ctx.botRuntime.now()). */
const inMin = (n: number) => new Date(ctx.clock.now().getTime() + n * MIN).toISOString();
const schedule = (payload: object, headers = ana, id = chatId) =>
  app.inject({ method: 'POST', url: `/api/chats/${id}/scheduled-messages`, headers, payload });

describe('POST /api/chats/:id/scheduled-messages (spec 2026-10-20 agendamentos §3.1)', () => {
  it('schedules a text in an open chat, records the event and lists it in the chat', async () => {
    const res = await schedule({ text: '  Lembrete da audiência  ', sendAt: inMin(10), signature: true });
    expect(res.statusCode).toBe(200);
    const dto = res.json() as ScheduledMessageDto;
    expect(dto).toMatchObject({
      chatId, body: 'Lembrete da audiência', signature: true, attachment: null, sendAt: inMin(10), status: 'pending',
      authorId: s.agentA.id, authorName: 'Ana Financeiro', contact: { name: 'Maria Cliente', phone: '5565999999999' },
      messageId: null, sentChatId: null, canEdit: true,
    });
    expect(await eventsOf(ctx, chatId)).toMatchObject([
      { kind: 'message_scheduled', data: { scheduledId: dto.id, sendAt: inMin(10) }, authorId: s.agentA.id },
    ]);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    const list = await app.inject({ method: 'GET', url: `/api/chats/${chatId}/scheduled-messages`, headers: ana });
    expect((list.json() as ScheduledMessageDto[]).map((r) => r.id)).toEqual([dto.id]);
  });

  it('stores the attachment when it is scheduled (multipart, fields before the file)', async () => {
    const pdf = Buffer.from('%PDF-1.4 petição');
    const mp = multipart({ text: 'Segue a petição', sendAt: inMin(10), signature: 'false' }, { name: 'peticao.pdf', mime: 'application/pdf', data: pdf });
    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/scheduled-messages`, headers: { ...ana, 'content-type': mp.contentType }, payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'Segue a petição', signature: false, attachment: { name: 'peticao.pdf', mime: 'application/pdf', size: pdf.length } });
    const [row] = await ctx.db.select().from(scheduledMessages);
    expect(await readFile(join(ctx.config.mediaDir, row!.mediaPath!))).toEqual(pdf);
  });

  it('refuses a closed chat (409), a time out of bounds or no text (400), a hidden chat (404) and no Origin (403)', async () => {
    const closed = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, state: 'closed' });
    const r409 = await schedule({ text: 'Oi', sendAt: inMin(10) }, ana, closed.chatId);
    expect([r409.statusCode, r409.json().error]).toEqual([409, 'Conversa finalizada']);

    const soon = await schedule({ text: 'Oi', sendAt: inMin(1) });
    expect([soon.statusCode, soon.json().error]).toEqual([400, 'Escolha um horário pelo menos 2 minutos à frente']);
    const far = await schedule({ text: 'Oi', sendAt: inMin(366 * 24 * 60) });
    expect([far.statusCode, far.json().error]).toEqual([400, 'Escolha um horário em até 1 ano']);
    expect((await schedule({ text: '   ', sendAt: inMin(10) })).statusCode).toBe(400);
    expect((await schedule({ text: 'x'.repeat(4097), sendAt: inMin(10) })).statusCode).toBe(400);
    expect((await schedule({ text: 'Oi', sendAt: '2026-10-14 13:10' })).statusCode).toBe(400);

    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await schedule({ text: 'Oi', sendAt: inMin(10) }, bruno)).statusCode).toBe(404);
    expect((await schedule({ text: 'Oi', sendAt: inMin(10) }, { cookie: ana.cookie! })).statusCode).toBe(403);

    expect(await ctx.db.select().from(scheduledMessages)).toEqual([]);
  });
});

describe('listing, editing and cancelling (spec §3.2)', () => {
  it("the page lists an agent's own rows and everyone's for an admin, by tab; the chat lists its pending ones", async () => {
    const mine = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(10)) });
    const brunos = await insertScheduled(ctx, { chatId, authorId: s.agentB.id, sendAt: new Date(inMin(5)) });
    const canceled = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(20)), status: 'canceled' });
    const admin = (await loginAs(app, s.admin.email)).headers;
    const ids = async (headers: Record<string, string>, status: string) =>
      ((await app.inject({ method: 'GET', url: `/api/scheduled-messages?status=${status}`, headers })).json() as ScheduledMessageDto[]).map((r) => r.id);

    expect(await ids(ana, 'pending')).toEqual([mine.id]);
    expect(await ids(admin, 'pending')).toEqual([brunos.id, mine.id]); // next first
    expect(await ids(ana, 'canceled')).toEqual([canceled.id]);
    expect(await ids(ana, 'sent')).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/scheduled-messages?status=nope', headers: ana })).statusCode).toBe(400);

    // the chat's own list: anyone who sees the chat, pending only, Editar only for the author (or an admin)
    const forChat = (await app.inject({ method: 'GET', url: `/api/chats/${chatId}/scheduled-messages`, headers: ana })).json() as ScheduledMessageDto[];
    expect(forChat.map((r) => [r.id, r.canEdit])).toEqual([[brunos.id, false], [mine.id, true]]);
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chatId}/scheduled-messages`, headers: bruno })).statusCode).toBe(404);
  });

  it('the author or an admin edits and cancels; anyone else gets 404; a row no longer pending is 409', async () => {
    const created = (await schedule({ text: 'Lembrete', sendAt: inMin(10), signature: false })).json() as ScheduledMessageDto;
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    const admin = (await loginAs(app, s.admin.email)).headers;
    const patch = (headers: Record<string, string>, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/scheduled-messages/${created.id}`, headers, payload });
    const cancel = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/api/scheduled-messages/${created.id}/cancel`, headers });

    expect((await patch(bruno, { text: 'x' })).statusCode).toBe(404);
    expect((await cancel(bruno)).statusCode).toBe(404);
    expect((await patch(ana, {})).statusCode).toBe(400);
    expect((await patch({ cookie: ana.cookie! }, { text: 'x' })).statusCode).toBe(403);

    const moved = await patch(admin, { sendAt: inMin(60) });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ sendAt: inMin(60), canEdit: true });
    expect((await patch(ana, { text: 'Lembrete: audiência às 9h' })).json()).toMatchObject({ body: 'Lembrete: audiência às 9h', sendAt: inMin(60) });
    expect((await patch(ana, { sendAt: inMin(1) })).statusCode).toBe(400);
    // a time change is an event; a text change is not
    expect((await eventsOf(ctx, chatId)).map((e) => [e.kind, e.data, e.authorId])).toEqual([
      ['message_scheduled', { scheduledId: created.id, sendAt: inMin(10) }, s.agentA.id],
      ['message_scheduled', { scheduledId: created.id, sendAt: inMin(60), edited: true }, s.admin.id],
    ]);

    expect((await cancel(ana)).json()).toMatchObject({ status: 'canceled', canEdit: false });
    expect((await eventsOf(ctx, chatId)).at(-1)).toMatchObject({ kind: 'scheduled_canceled', data: { scheduledId: created.id }, authorId: s.agentA.id });
    const again = await cancel(ana);
    expect([again.statusCode, again.json().error]).toEqual([409, NOT_PENDING]);
    expect((await patch(ana, { text: 'y' })).statusCode).toBe(409);
  });
});
```

In `server/test/history/merge.test.ts`, replace

```ts
import {
  chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, deletedChats, messages, tags,
} from '../../src/db/schema.js';
```

with

```ts
import {
  chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, deletedChats, messages, scheduledMessages, tags,
} from '../../src/db/schema.js';
```

and add after the test `an absorbed chat's conversation tags move to the twin (Review Focus 6)`:

```ts
  it("an absorbed chat's scheduled messages move to the twin (spec 2026-10-20 agendamentos §3.3)", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: phoneId });
    await ctx.db.insert(scheduledMessages).values({ chatId: lidChat, authorId: s.agentA.id, body: 'Lembrete', signature: false, sendAt: new Date() });

    await mergeLidPairs(ctx, pair);

    expect((await ctx.db.select().from(scheduledMessages)).map((r) => r.chatId)).toEqual([phoneChat]);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test -w server -- test/automation/scheduled-api.test.ts test/history/merge.test.ts`
Expected: FAIL. `../../src/automation/scheduled.js` does not exist. Then the merge test FAILs with `[]` (the cascade deleted the row) where `[phoneChat]` is expected.

- [ ] **Step 4: Share the multipart reader**

In `server/src/chats/routes.ts`, replace

```ts
async function readMultipart(req: FastifyRequest): Promise<SendInput> {
  const fields: Record<string, string> = {};
  let file: SendInput['file'];
```

with

```ts
/** Every field and the one file of a multipart body; 413 past 64 MB. The scheduled-message route reads it too. */
export async function readParts(req: FastifyRequest): Promise<{ fields: Record<string, string>; file?: SendInput['file'] }> {
  const fields: Record<string, string> = {};
  let file: SendInput['file'];
```

and replace

```ts
    throw err;
  }
  if (!file) throw badRequest('Arquivo ausente');
  const f = multipartFields.parse(fields);
```

with

```ts
    throw err;
  }
  return { fields, file };
}

async function readMultipart(req: FastifyRequest): Promise<SendInput> {
  const { fields, file } = await readParts(req);
  if (!file) throw badRequest('Arquivo ausente');
  const f = multipartFields.parse(fields);
```

- [ ] **Step 5: Write the service**

Create `server/src/automation/scheduled.ts`:

```ts
// Spec 2026-10-20 agendamentos §3.1–3.2: schedule, list, edit and cancel. Sending is delivery.ts.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { scheduleTimeProblem, type ScheduledMessageDto, type ScheduledStatus, type ScheduledTab } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { chats, contacts, messages, scheduledMessages, users } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import type { AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { saveMedia } from '../messages/media.js';

type ScheduledRow = typeof scheduledMessages.$inferSelect;

export const NOT_PENDING = 'Esta mensagem agendada não está mais pendente';
/** Still to go out: the chat's strip and the "Pendentes" tab show both. */
export const OPEN_STATUSES: ScheduledStatus[] = ['pending', 'sending'];
// ponytail: one page of 100 per tab, no cursor; add keyset paging on (send_at, id) if an office ever keeps more.
const LIST_LIMIT = 100;

export interface ScheduleInput { text: string; sendAt: Date; signature: boolean; file?: { buffer: Buffer; mime: string; name: string } }

const canManage = (user: AuthUser, row: { authorId: string }) => row.authorId === user.id || user.role === 'admin';

/** The rows `where` picks, with the chat's contact, the author's name and the chat the sent message went to. */
async function scheduledDtos(db: Db, user: AuthUser, where: SQL | undefined, order: SQL[]): Promise<ScheduledMessageDto[]> {
  const rows = await db
    .select({
      s: scheduledMessages, contactId: contacts.id, contactName: contacts.name, contactPhone: contacts.phone,
      authorName: users.name, sentChatId: messages.chatId,
    })
    .from(scheduledMessages)
    .innerJoin(chats, eq(chats.id, scheduledMessages.chatId))
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(users, eq(users.id, scheduledMessages.authorId))
    .leftJoin(messages, eq(messages.id, scheduledMessages.messageId))
    .where(where)
    .orderBy(...order)
    .limit(LIST_LIMIT);
  return rows.map(({ s, ...r }) => ({
    id: s.id,
    chatId: s.chatId,
    contact: { id: r.contactId, name: r.contactName, phone: r.contactPhone },
    authorId: s.authorId,
    authorName: r.authorName,
    body: s.body,
    signature: s.signature,
    attachment: s.mediaPath
      ? { name: s.mediaName ?? 'arquivo', mime: s.mediaMime ?? 'application/octet-stream', size: s.mediaSize ?? 0 }
      : null,
    sendAt: s.sendAt.toISOString(),
    status: s.status,
    error: s.error,
    messageId: s.messageId,
    sentChatId: r.sentChatId,
    createdAt: s.createdAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    canEdit: s.status === 'pending' && canManage(user, s),
  }));
}

async function dtoOf(db: Db, user: AuthUser, id: string): Promise<ScheduledMessageDto> {
  const [dto] = await scheduledDtos(db, user, eq(scheduledMessages.id, id), [asc(scheduledMessages.id)]);
  if (!dto) throw notFound();
  return dto;
}

/** The author's or an admin's pending row; 404 for anyone else (it reveals nothing), 409 once it left 'pending'. */
async function pendingRowFor(ctx: AppCtx, user: AuthUser, id: string): Promise<ScheduledRow> {
  const [row] = await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id));
  if (!row || !canManage(user, row)) throw notFound();
  if (row.status !== 'pending') throw conflict(NOT_PENDING);
  return row;
}

export async function createScheduled(ctx: AppCtx, user: AuthUser, chatId: string, input: ScheduleInput): Promise<ScheduledMessageDto> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada');
  const problem = scheduleTimeProblem(input.sendAt, ctx.botRuntime.now());
  if (problem) throw badRequest(problem);
  // spec §3.1: the file is stored now, not at send time
  const saved = input.file ? await saveMedia(ctx.config.mediaDir, input.file.buffer, input.file.mime, input.file.name) : null;
  const id = randomUUID();
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  await ctx.db.transaction(async (tx) => {
    await tx.insert(scheduledMessages).values({
      id, chatId, authorId: user.id, body: input.text, signature: input.signature, sendAt: input.sendAt,
      mediaPath: saved?.path ?? null, mediaMime: input.file?.mime ?? null, mediaName: input.file?.name ?? null,
      mediaSize: saved?.size ?? null, mediaSha256: saved?.sha256 ?? null,
    });
    await addEvent(tx, chatId, 'message_scheduled', { scheduledId: id, sendAt: input.sendAt.toISOString() }, user.id);
  });
  await ctx.hub.publishChat(chatId); // open screens refetch the timeline and the strip
  return dtoOf(ctx.db, user, id);
}

/** Spec §3.2: the chat's strip — everyone who sees the chat, pending (and being sent), next first. */
export async function listChatScheduled(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ScheduledMessageDto[]> {
  await getChatForUser(ctx, user, chatId);
  return scheduledDtos(
    ctx.db,
    user,
    and(eq(scheduledMessages.chatId, chatId), inArray(scheduledMessages.status, OPEN_STATUSES)),
    [asc(scheduledMessages.sendAt), asc(scheduledMessages.id)],
  );
}

/** Spec §3.2: "Agendamentos" — mine (an admin: everyone's); pending next first, the other tabs newest first. */
export async function listScheduled(ctx: AppCtx, user: AuthUser, tab: ScheduledTab): Promise<ScheduledMessageDto[]> {
  const status = tab === 'pending' ? inArray(scheduledMessages.status, OPEN_STATUSES) : eq(scheduledMessages.status, tab);
  const mine = user.role === 'admin' ? undefined : eq(scheduledMessages.authorId, user.id);
  const order = tab === 'pending'
    ? [asc(scheduledMessages.sendAt), asc(scheduledMessages.id)]
    : [desc(scheduledMessages.sendAt), desc(scheduledMessages.id)];
  return scheduledDtos(ctx.db, user, and(status, mine), order);
}

export async function updateScheduled(
  ctx: AppCtx,
  user: AuthUser,
  id: string,
  patch: { text?: string; sendAt?: Date },
): Promise<ScheduledMessageDto> {
  const row = await pendingRowFor(ctx, user, id);
  if (patch.sendAt) {
    const problem = scheduleTimeProblem(patch.sendAt, ctx.botRuntime.now());
    if (problem) throw badRequest(problem);
  }
  await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(scheduledMessages)
      .set({ ...(patch.text !== undefined ? { body: patch.text } : {}), ...(patch.sendAt ? { sendAt: patch.sendAt } : {}) })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending'))) // the worker may have claimed it
      .returning({ id: scheduledMessages.id });
    if (!updated) throw conflict(NOT_PENDING);
    if (patch.sendAt && patch.sendAt.getTime() !== row.sendAt.getTime()) {
      await addEvent(tx, row.chatId, 'message_scheduled', { scheduledId: id, sendAt: patch.sendAt.toISOString(), edited: true }, user.id);
    }
  });
  await ctx.hub.publishChat(row.chatId);
  return dtoOf(ctx.db, user, id);
}

// ponytail: a cancelled row keeps its file on disk, like every other media file today; prune with the media sweep if one lands.
export async function cancelScheduled(ctx: AppCtx, user: AuthUser, id: string): Promise<ScheduledMessageDto> {
  const row = await pendingRowFor(ctx, user, id);
  await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(scheduledMessages)
      .set({ status: 'canceled', finishedAt: ctx.botRuntime.now() })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')))
      .returning({ id: scheduledMessages.id });
    if (!updated) throw conflict(NOT_PENDING);
    await addEvent(tx, row.chatId, 'scheduled_canceled', { scheduledId: id }, user.id);
  });
  await ctx.hub.publishChat(row.chatId);
  return dtoOf(ctx.db, user, id);
}
```

- [ ] **Step 6: Write the routes and register them**

Create `server/src/automation/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SCHEDULE_TEXT_MAX, SCHEDULED_TABS } from '@talk/shared';
import { readParts } from '../chats/routes.js';
import type { AppCtx } from '../ctx.js';
import { cancelScheduled, createScheduled, listChatScheduled, listScheduled, updateScheduled } from './scheduled.js';

const idParams = z.object({ id: z.uuid() });
const text = z.string().trim().min(1).max(SCHEDULE_TEXT_MAX);
const sendAt = z.iso.datetime({ offset: true });
const createJson = z.object({ text, sendAt, signature: z.boolean().default(true) });
/** Multipart: the same fields, before the one file (same limits as a send). */
const createFields = z.object({ text, sendAt, signature: z.stringbool().default(true) });
const patchBody = z
  .object({ text: text.optional(), sendAt: sendAt.optional() })
  .refine((b) => b.text !== undefined || b.sendAt !== undefined, 'Nada para alterar');
const listQuery = z.object({ status: z.enum(SCHEDULED_TABS).default('pending') });

/** Spec 2026-10-20 agendamentos §5. */
export function registerAutomationRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.post('/api/chats/:id/scheduled-messages', async (req) => {
    const { id } = idParams.parse(req.params);
    if (req.isMultipart()) {
      const { fields, file } = await readParts(req);
      const f = createFields.parse(fields);
      return createScheduled(ctx, req.user, id, { text: f.text, sendAt: new Date(f.sendAt), signature: f.signature, file });
    }
    const b = createJson.parse(req.body);
    return createScheduled(ctx, req.user, id, { text: b.text, sendAt: new Date(b.sendAt), signature: b.signature });
  });

  app.get('/api/chats/:id/scheduled-messages', async (req) => listChatScheduled(ctx, req.user, idParams.parse(req.params).id));

  app.get('/api/scheduled-messages', async (req) => listScheduled(ctx, req.user, listQuery.parse(req.query).status));

  app.patch('/api/scheduled-messages/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = patchBody.parse(req.body);
    return updateScheduled(ctx, req.user, id, { text: b.text, sendAt: b.sendAt ? new Date(b.sendAt) : undefined });
  });

  app.post('/api/scheduled-messages/:id/cancel', async (req) => cancelScheduled(ctx, req.user, idParams.parse(req.params).id));
}
```

In `server/src/app.ts`, after `import { registerBotRoutes } from './bots/routes.js';`, add:

```ts
import { registerAutomationRoutes } from './automation/routes.js';
```

and replace

```ts
  await chatRoutes(app, ctx);
```

with

```ts
  await chatRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
```

- [ ] **Step 7: Keep scheduled rows through a LID merge**

In `server/src/history/merge.ts`, replace

```ts
  botRuns, chatEvents, chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, deletedChats, messages,
} from '../db/schema.js';
```

with

```ts
  botRuns, chatEvents, chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, deletedChats, messages,
  scheduledMessages,
} from '../db/schema.js';
```

and replace

```ts
  await tx.delete(chats).where(eq(chats.id, from.id));
  const newer = from.lastMessageAt !== null
```

with

```ts
  // spec 2026-10-20 agendamentos §3.3: scheduled messages follow the chat (the delete below would cascade them away)
  await tx.update(scheduledMessages).set({ chatId: twin.id }).where(eq(scheduledMessages.chatId, from.id));
  await tx.delete(chats).where(eq(chats.id, from.id));
  const newer = from.lastMessageAt !== null
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -w server -- test/automation/scheduled-api.test.ts test/history/merge.test.ts test/messages/send.test.ts test/messages/stickers.test.ts test/messages/actions.test.ts`
Expected: PASS. The send, sticker and multipart-send tests prove `readMultipart` still needs a file and still maps 413.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/chats/routes.ts server/src/automation/scheduled.ts server/src/automation/routes.ts server/src/app.ts server/src/history/merge.ts server/test/automation/seed.ts server/test/automation/scheduled-api.test.ts server/test/history/merge.test.ts
git commit -m "feat(server): schedule, list, edit and cancel scheduled messages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Delivery: the claim, the send as the author, and failures

The worker beat copies `createScheduler.tick` from `bots/scheduler.ts`: claim in a short transaction under `SKIP LOCKED`, then do the work outside it. The claim also flips the row to `sending`, so the claim alone stops a second beat or a second process. The outcome `UPDATE … WHERE status = 'sending'` makes the stuck sweep and a late finish exclusive.

**Files:**
- Modify: `server/src/messages/send.ts` (`SendInput`, `sendAgentMessage`)
- Modify: `server/src/messages/dto.ts` (`toMessageDto`)
- Modify: `server/src/realtime/hub.ts` (`Hub`, `createHub`, `createRecordingHub`)
- Create: `server/src/automation/delivery.ts`
- Test: `server/test/automation/delivery.test.ts` (create), `server/test/messages/dto.test.ts`, `server/test/realtime/hub.test.ts`

**Interfaces:**
- Consumes: Task 1 `scheduledMessages`, `messages.scheduled`, `NotificationDto.kind`; Task 2 `insertScheduled`, `runningBot`; existing `startChat`, `sendAgentMessage`, `loadAuthUser`, `errorTag`.
- Produces: `SendInput.storedFile?`, `SendInput.scheduled?`, `MessageDto.scheduled` filled, `hub.notifyUser`, `deliverDueScheduled`, `failStuckScheduled`, `FAIL`, `LATE_MS`, `STUCK_MS` (Task 5 calls `deliverDueScheduled`).

- [ ] **Step 1: Write the failing tests**

Create `server/test/automation/delivery.test.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAIL, deliverDueScheduled } from '../../src/automation/delivery.js';
import { botRuns, chats, messages, scheduledMessages, users } from '../../src/db/schema.js';
import { saveMedia } from '../../src/messages/media.js';
import { formatSignature, signatureLabel } from '../../src/messages/signature.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { insertScheduled, runningBot } from './seed.js';

const MIN = 60_000;
const PHONE = '5565999999999';
const TEXT = 'Lembrete: audiência amanhã às 9h';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let chatId: string;
let contactId: string;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ chatId, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: PHONE }));
});
afterEach(() => vi.restoreAllMocks());

const inMin = (n: number) => new Date(ctx.clock.now().getTime() + n * MIN);
const beat = () => deliverDueScheduled(ctx, ctx.clock.now());
const rowOf = async (id: string) => (await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)))[0]!;
const messageOf = async (id: string | null) => (await ctx.db.select().from(messages).where(eq(messages.id, id!)))[0]!;
const texts = () => ctx.wa.sent.filter((x) => x.method === 'sendText');
const due = (extra: Partial<typeof scheduledMessages.$inferInsert> = {}) =>
  insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: inMin(-1), body: TEXT, ...extra });
const closeOriginal = () => ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, chatId));

describe('deliverDueScheduled (spec 2026-10-20 agendamentos §3.3)', () => {
  it('sends at its time and not before, as the author, exactly once', async () => {
    const row = await due({ sendAt: inMin(10) });
    expect(await beat()).toBe(0);
    ctx.clock.advance(10 * MIN);
    expect(await beat()).toBe(1);
    expect(await beat()).toBe(0);

    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatchObject({ phone: PHONE, payload: { text: TEXT } });
    const done = await rowOf(row.id);
    expect(done).toMatchObject({ status: 'sent', error: null, finishedAt: ctx.clock.now() });
    expect(await messageOf(done.messageId)).toMatchObject({ chatId, authorId: s.agentA.id, body: TEXT, scheduled: true, status: 'sent' });
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
  });

  it('two beats at the same time still send it once (Review Focus 1)', async () => {
    await due();
    const [a, b] = await Promise.all([beat(), beat()]);
    expect(a + b).toBe(1);
    expect(texts()).toHaveLength(1);
  });

  it('a row stuck in sending for more than 10 minutes fails and is never sent again (Review Focus 1)', async () => {
    const stuck = await due({ sendAt: inMin(-20), status: 'sending', claimedAt: inMin(-11) });
    const busy = await due({ sendAt: inMin(-5), status: 'sending', claimedAt: inMin(-5) });
    expect(await beat()).toBe(0);
    expect(await rowOf(stuck.id)).toMatchObject({ status: 'failed', error: FAIL.stuck, messageId: null });
    expect((await rowOf(busy.id)).status).toBe('sending');
    expect(texts()).toEqual([]);
    expect(ctx.hub.events).toContainEqual({ type: 'notification', chatId, userId: s.agentA.id });
  });

  it("signs like a normal send, with the author's signature at send time", async () => {
    await due({ signature: true });
    await beat();
    expect(texts()[0]!.payload).toMatchObject({ text: formatSignature(TEXT, signatureLabel(s.agentA, 'Financeiro')) });
  });

  it('sends the file stored at schedule time, with the text as its caption', async () => {
    const pdf = Buffer.from('%PDF-1.4 petição');
    const saved = await saveMedia(ctx.config.mediaDir, pdf, 'application/pdf', 'peticao.pdf');
    const row = await due({
      body: 'Segue a petição', mediaPath: saved.path, mediaMime: 'application/pdf', mediaName: 'peticao.pdf', mediaSize: saved.size,
      mediaSha256: saved.sha256,
    });
    expect(await beat()).toBe(1);
    expect(ctx.wa.sent.find((x) => x.method === 'sendMedia')?.payload).toMatchObject({
      media: { kind: 'document', base64: pdf.toString('base64'), mime: 'application/pdf', fileName: 'peticao.pdf', caption: 'Segue a petição' },
    });
    expect(await messageOf((await rowOf(row.id)).messageId)).toMatchObject({ kind: 'document', mediaPath: saved.path, body: 'Segue a petição' });
  });

  it('a closed chat: opens a new chat in the original sector with the author as owner, like "Nova conversa" (Review Focus 2)', async () => {
    await closeOriginal();
    const row = await due();
    expect(await beat()).toBe(1);
    const [open] = await ctx.db.select().from(chats).where(and(eq(chats.contactId, contactId), eq(chats.state, 'open')));
    expect(open).toMatchObject({ sectorId: s.sectorA, ownerId: s.agentA.id });
    expect((await messageOf((await rowOf(row.id)).messageId)).chatId).toBe(open!.id);
    expect((await eventsOf(ctx, open!.id))[0]).toMatchObject({ kind: 'created', authorId: s.agentA.id });
  });

  it('an open chat the author cannot see: fails with the reason, sends nothing and tells only the author (Review Focus 2)', async () => {
    await closeOriginal();
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id, contactId });
    const row = await due();
    expect(await beat()).toBe(0);
    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error: 'Este contato já está em atendimento em outro setor', messageId: null });
    expect(texts()).toEqual([]);
    expect(ctx.hub.events.filter((e) => e.type === 'notification')).toEqual([{ type: 'notification', chatId, userId: s.agentA.id }]);
  });

  it('a deactivated author fails without sending', async () => {
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, s.agentA.id));
    const row = await due();
    await beat();
    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error: FAIL.authorInactive });
    expect(texts()).toEqual([]);
  });

  it('WhatsApp refusing it fails with the message id, so the bubble can be resent', async () => {
    ctx.wa.failNext();
    const row = await due();
    expect(await beat()).toBe(0);
    const failed = await rowOf(row.id);
    expect(failed).toMatchObject({ status: 'failed', error: FAIL.refused });
    expect(await messageOf(failed.messageId)).toMatchObject({ status: 'failed', scheduled: true });
  });

  it('a running chatbot keeps running', async () => {
    const runId = await runningBot(ctx, chatId, contactId);
    await due();
    expect(await beat()).toBe(1);
    expect((await ctx.db.select().from(botRuns).where(eq(botRuns.id, runId)))[0]!.state).toBe('waiting_reply');
  });

  it('more than an hour late (the server was down): fails without sending', async () => {
    const row = await due({ sendAt: inMin(-61) });
    await beat();
    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error: FAIL.late });
    expect(texts()).toEqual([]);
  });

  it('a cancelled row is never sent', async () => {
    await due({ status: 'canceled' });
    expect(await beat()).toBe(0);
    expect(texts()).toEqual([]);
  });
});

describe('the send route (Review Focus 6)', () => {
  it('never takes storedFile or scheduled from the body', async () => {
    const { app } = await makeTestApp(ctx);
    const { headers } = await loginAs(app, s.agentA.email);
    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers,
      payload: {
        text: 'Oi', signature: false, scheduled: true,
        storedFile: { path: '../../segredo.txt', mime: 'text/plain', name: 'segredo.txt', size: 1, sha256: null },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'text', media: null, scheduled: false });
    await app.close();
  });
});
```

In `server/test/messages/dto.test.ts` and in `server/test/realtime/hub.test.ts`, replace (one occurrence in each file)

```ts
      officeReaction: null, deleted: null, edited: null, forwarded: false, favorite: null,
```

with

```ts
      officeReaction: null, deleted: null, edited: null, forwarded: false, favorite: null, scheduled: false,
```

In `server/test/realtime/hub.test.ts`, add at the end of the file:

```ts
describe('notifyUser (spec 2026-10-20 agendamentos §3.3)', () => {
  it('real hub sends to that user only, with no chat check', () => {
    const a = fakeSocket(); const b = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b);
    const n: NotificationDto = {
      id: 'n2', chatId: randomUUID(), title: 'Mensagem agendada não enviada', text: 'Erro inesperado', botName: '',
      kind: 'scheduled_failed', createdAt: '2026-10-14T13:00:00.000Z',
    };
    hub.notifyUser(s.agentA.id, n);
    expect(a.events).toEqual([{ type: 'notification', notification: n }]);
    expect(b.events).toEqual([]);
  });

  it('recording hub records it like a notification', () => {
    const rec = createRecordingHub();
    rec.notifyUser('u1', { id: 'n1', chatId: 'c1', title: 't', text: 'x', botName: '', createdAt: '2026-10-14T13:00:00.000Z' });
    expect(rec.events).toEqual([{ type: 'notification', chatId: 'c1', userId: 'u1' }]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/automation/delivery.test.ts test/messages/dto.test.ts test/realtime/hub.test.ts`
Expected: FAIL. `../../src/automation/delivery.js` does not exist, `hub.notifyUser` is not a function, and the DTO literals miss `scheduled`.

- [ ] **Step 3: Let the worker send a stored file and mark the message**

In `server/src/messages/send.ts`, in `SendInput`, replace

```ts
  /** Spec §5.5: the agent's answer to BOT_RUNNING; absent = settings.bot_running_behavior decides. */
  botAction?: BotAction;
}
```

with

```ts
  /** Spec §5.5: the agent's answer to BOT_RUNNING; absent = settings.bot_running_behavior decides. */
  botAction?: BotAction;
  /**
   * Spec 2026-10-20 agendamentos §3.3, scheduled-message worker only (the routes build SendInput from zod fields, so a
   * body can never set it): the file saved when the message was scheduled. The text is its caption.
   */
  storedFile?: { path: string; mime: string; name: string; size: number; sha256: string | null };
  /** Same: the message carries the "Agendada" mark. */
  scheduled?: boolean;
}
```

In `sendAgentMessage`, replace

```ts
  const text = asVoice || asSticker || source ? null : input.text?.trim() || null;
  if (!text && !file && !source) throw badRequest('Mensagem vazia');
```

with

```ts
  const text = asVoice || asSticker || source ? null : input.text?.trim() || null;
  const stored = input.storedFile ?? null;
  if (!text && !file && !source && !stored) throw badRequest('Mensagem vazia');
```

replace

```ts
  const kind: OutKind = source ? (source.kind as OutKind) : asSticker ? 'sticker' : file ? fileKind(file.mime, asVoice) : 'text';
```

with

```ts
  const kind: OutKind = source
    ? (source.kind as OutKind)
    : asSticker ? 'sticker' : file ? fileKind(file.mime, asVoice) : stored ? fileKind(stored.mime, false) : 'text';
```

replace

```ts
  const media = source
    ? { path: source.mediaPath, mime: source.mediaMime, size: source.mediaSize, name: source.mediaName, sha256: source.mediaSha256 }
    : { path: saved?.path ?? null, mime: file?.mime ?? null, size: saved?.size ?? null, name: file?.name ?? null, sha256: saved?.sha256 ?? null };
```

with

```ts
  const media = source
    ? { path: source.mediaPath, mime: source.mediaMime, size: source.mediaSize, name: source.mediaName, sha256: source.mediaSha256 }
    : stored
      ? { ...stored }
      : { path: saved?.path ?? null, mime: file?.mime ?? null, size: saved?.size ?? null, name: file?.name ?? null, sha256: saved?.sha256 ?? null };
```

and replace

```ts
        forwardedFromId: forwarded?.id ?? null,
        authorId: user.id,
```

with

```ts
        forwardedFromId: forwarded?.id ?? null,
        scheduled: input.scheduled ?? false,
        authorId: user.id,
```

In `server/src/messages/dto.ts`, replace

```ts
    forwarded: row.forwardedFromId !== null,
```

with

```ts
    forwarded: row.forwardedFromId !== null,
    scheduled: row.scheduled,
```

- [ ] **Step 4: Tell one user, whatever chats they see**

In `server/src/realtime/hub.ts`, in `interface Hub`, after the `publishNotification(…)` line, add:

```ts
  /** One user's sockets, no chat check: a failed scheduled message reaches its author even without access to the chat. */
  notifyUser(userId: string, notification: NotificationDto): void;
```

In `createHub`, before `publishUsersChanged() {`, add:

```ts
    notifyUser(userId, notification) {
      for (const socket of [...(byUser.get(userId) ?? [])]) send(socket, { type: 'notification', notification });
    },
```

In `createRecordingHub`, before `publishUsersChanged: () => {`, add:

```ts
    notifyUser: (userId, n) => { events.push({ type: 'notification', chatId: n.chatId, userId }); },
```

- [ ] **Step 5: Write the delivery**

Create `server/src/automation/delivery.ts`:

```ts
// Spec 2026-10-20 agendamentos §3.3: the scheduled-message beat. pending → sending is claimed under FOR UPDATE SKIP LOCKED
// in one transaction; the outcome is written only while the row is still 'sending'. So a row goes out at most once, and
// a row left in 'sending' by a restart fails instead of going out again (WhatsApp may already have it).
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, lte } from 'drizzle-orm';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { chats, scheduledMessages } from '../db/schema.js';
import { startChat } from '../inbox/chats.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { HttpError } from '../lib/http-error.js';
import { sendAgentMessage } from '../messages/send.js';

const BATCH = 20;
/** Later than this past its time (the server was down), a row fails instead of going out. */
export const LATE_MS = 60 * 60_000;
/** A row 'sending' for longer was interrupted. */
export const STUCK_MS = 10 * 60_000;

export const FAIL = {
  late: 'Não enviada: o sistema estava fora do ar no horário agendado',
  authorInactive: 'Não enviada: o autor do agendamento está desativado',
  noAccess: 'Não enviada: o autor não tem mais acesso a esta conversa',
  refused: 'O WhatsApp não aceitou a mensagem; ela pode ser reenviada na conversa',
  stuck: 'Envio interrompido; confira a conversa antes de agendar de novo',
  unexpected: 'Erro inesperado',
} as const;

type Outcome = { status: 'sent'; messageId: string } | { status: 'failed'; error: string; messageId?: string | null };

function notifyFailure(ctx: AppCtx, row: { chatId: string; authorId: string }, error: string, now: Date): void {
  ctx.hub.notifyUser(row.authorId, {
    id: randomUUID(), chatId: row.chatId, title: 'Mensagem agendada não enviada', text: error, botName: '',
    kind: 'scheduled_failed', createdAt: now.toISOString(),
  });
}

/** Writes the outcome if the row is still 'sending', refreshes the original chat's screens and tells the author of a failure. */
async function finish(ctx: AppCtx, id: string, outcome: Outcome, now: Date): Promise<void> {
  const [row] = await ctx.db
    .update(scheduledMessages)
    .set({
      status: outcome.status,
      error: outcome.status === 'failed' ? outcome.error : null,
      messageId: outcome.messageId ?? null,
      finishedAt: now,
    })
    .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'sending')))
    .returning({ chatId: scheduledMessages.chatId, authorId: scheduledMessages.authorId });
  if (!row) return;
  await ctx.hub.publishChat(row.chatId);
  if (outcome.status === 'failed') notifyFailure(ctx, row, outcome.error, now);
}

async function deliverOne(ctx: AppCtx, id: string, now: Date): Promise<Outcome> {
  const [row] = await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id));
  if (!row) return { status: 'failed', error: FAIL.unexpected }; // its chat was deleted meanwhile: finish() finds nothing
  if (now.getTime() - row.sendAt.getTime() > LATE_MS) return { status: 'failed', error: FAIL.late };
  const author = await loadAuthUser(ctx.db, row.authorId); // null when deactivated
  if (!author) return { status: 'failed', error: FAIL.authorInactive };
  const [origin] = await ctx.db.select().from(chats).where(eq(chats.id, row.chatId));
  if (!origin) return { status: 'failed', error: FAIL.unexpected };
  try {
    // "Nova conversa" (§5.3a): the contact's open chat on that number when the author sees it, else a new one in the
    // original sector owned by the author; an open chat the author cannot see is startChat's 409.
    const chat = await startChat(ctx, author, { contactId: origin.contactId, sectorId: origin.sectorId, channelId: origin.channelId });
    const message = await sendAgentMessage(ctx, author, chat.id, {
      text: row.body,
      signature: row.signature,
      botAction: 'keep', // spec §3.3: a running chatbot goes on
      scheduled: true,
      storedFile: row.mediaPath
        ? { path: row.mediaPath, mime: row.mediaMime ?? 'application/octet-stream', name: row.mediaName ?? 'arquivo', size: row.mediaSize ?? 0, sha256: row.mediaSha256 }
        : undefined,
    });
    return message.status === 'failed'
      ? { status: 'failed', error: FAIL.refused, messageId: message.id }
      : { status: 'sent', messageId: message.id };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: 'failed', error: err.status === 404 ? FAIL.noAccess : err.message.replace(/\.$/, '') };
  }
}

/** Rows left in 'sending' longer than STUCK_MS: failed, never sent again. */
export async function failStuckScheduled(ctx: AppCtx, now: Date): Promise<number> {
  const rows = await ctx.db
    .update(scheduledMessages)
    .set({ status: 'failed', error: FAIL.stuck, finishedAt: now })
    .where(and(eq(scheduledMessages.status, 'sending'), lt(scheduledMessages.claimedAt, new Date(now.getTime() - STUCK_MS))))
    .returning({ chatId: scheduledMessages.chatId, authorId: scheduledMessages.authorId });
  for (const row of rows) {
    await ctx.hub.publishChat(row.chatId);
    notifyFailure(ctx, row, FAIL.stuck, now);
  }
  return rows.length;
}

/** One beat: fail the stuck rows, then claim and send the due ones, one at a time. Returns how many went out. */
export async function deliverDueScheduled(ctx: AppCtx, now: Date = ctx.botRuntime.now()): Promise<number> {
  await failStuckScheduled(ctx, now);
  const ids = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: scheduledMessages.id })
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.status, 'pending'), lte(scheduledMessages.sendAt, now)))
      .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.id))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    const claimed = rows.map((r) => r.id);
    if (claimed.length) {
      await tx.update(scheduledMessages).set({ status: 'sending', claimedAt: now }).where(inArray(scheduledMessages.id, claimed));
    }
    return claimed;
  });

  let sent = 0;
  for (const id of ids) {
    let outcome: Outcome;
    try {
      outcome = await deliverOne(ctx, id, now);
    } catch (err) {
      // one broken row must not hold back the rest of the batch
      console.error('scheduled message failed', { id, err: errorTag(err) });
      outcome = { status: 'failed', error: FAIL.unexpected };
    }
    await finish(ctx, id, outcome, now);
    if (outcome.status === 'sent') sent += 1;
  }
  return sent;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/automation test/messages test/realtime/hub.test.ts test/inbox/chats-start.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/messages/send.ts server/src/messages/dto.ts server/src/realtime/hub.ts server/src/automation/delivery.ts server/test/automation/delivery.test.ts server/test/messages/dto.test.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): send due scheduled messages once, as the author, and tell the author of a failure" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Automatic rules settings (API)

The rules get their own endpoint. `PUT /api/settings` replaces the whole `SettingsDto`, and an omitted field resets to its default, so putting `autoRules` in there would let any older client switch the rules off.

**Files:**
- Modify: `server/src/catalog/settings.ts` (imports, `AutoRulesBody`, `getAutoRules`, two routes)
- Test: `server/test/catalog/settings.test.ts`

**Interfaces:**
- Consumes: Task 1 `AutoRulesDto`, `DEFAULT_AUTO_RULES`, `RETURN_TO_QUEUE_MINUTES`, `CLOSE_INACTIVE_HOURS`.
- Produces: `getAutoRules(db)` (Task 5), `GET`/`PUT /api/settings/auto-rules` (Task 9).

- [ ] **Step 1: Write the failing test**

In `server/test/catalog/settings.test.ts`, replace

```ts
import { getBotRunningBehavior } from '../../src/catalog/settings.js';
```

with

```ts
import { DEFAULT_AUTO_RULES } from '@talk/shared';
import { getAutoRules, getBotRunningBehavior } from '../../src/catalog/settings.js';
```

and add at the end of the file:

```ts
it('auto rules: both off by default, admin only, saved apart from the other settings and validated (spec 2026-10-20 agendamentos §4)', async () => {
  const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/settings/auto-rules', headers });
  const putRules = (headers: Record<string, string>, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/settings/auto-rules', headers, payload });
  const rules = { returnToQueue: { enabled: true, minutes: 45 }, closeInactive: { enabled: true, hours: 48, sendClosingMessage: false } };

  expect((await get(admin)).json()).toEqual(DEFAULT_AUTO_RULES);
  expect((await get(agent)).statusCode).toBe(403);
  expect((await putRules(agent, rules)).statusCode).toBe(403);
  expect((await putRules({ cookie: admin.cookie! }, rules)).statusCode).toBe(403); // no Origin

  const saved = await putRules(admin, rules);
  expect([saved.statusCode, saved.json()]).toEqual([200, rules]);
  expect(await getAutoRules(ctx.db)).toEqual(rules);

  // the whole-settings PUT does not touch them
  expect((await put(admin, { closingMessage: 'Tchau', triageMenu: { enabled: false, welcomeText: '', invalidText: '', options: [] } })).statusCode).toBe(200);
  expect(await getAutoRules(ctx.db)).toEqual(rules);

  for (const bad of [
    { ...rules, returnToQueue: { enabled: true, minutes: 4 } },
    { ...rules, returnToQueue: { enabled: true, minutes: 1441 } },
    { ...rules, closeInactive: { enabled: true, hours: 0, sendClosingMessage: true } },
    { ...rules, closeInactive: { enabled: true, hours: 721, sendClosingMessage: true } },
    { ...rules, closeInactive: { enabled: true, hours: 1.5, sendClosingMessage: true } },
    { returnToQueue: rules.returnToQueue },
  ]) {
    expect((await putRules(admin, bad)).statusCode).toBe(400);
  }
  expect(await getAutoRules(ctx.db)).toEqual(rules);

  // a broken stored value reads as the defaults (both off)
  await ctx.db.update(settings).set({ value: { returnToQueue: 'sim' } }).where(eq(settings.key, 'auto_rules'));
  expect(await getAutoRules(ctx.db)).toEqual(DEFAULT_AUTO_RULES);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: FAIL. `getAutoRules` is not exported by `settings.js`.

- [ ] **Step 3: Read, validate and store the rules**

In `server/src/catalog/settings.ts`, replace

```ts
import type { BotRunningBehavior, SettingsDto } from '@talk/shared';
```

with

```ts
import {
  CLOSE_INACTIVE_HOURS, DEFAULT_AUTO_RULES, RETURN_TO_QUEUE_MINUTES, type AutoRulesDto, type BotRunningBehavior, type SettingsDto,
} from '@talk/shared';
```

After the `getBotRunningBehavior` function, add:

```ts
const AutoRulesBody = z.object({
  returnToQueue: z.object({
    enabled: z.boolean(),
    minutes: z.number().int().min(RETURN_TO_QUEUE_MINUTES.min).max(RETURN_TO_QUEUE_MINUTES.max),
  }),
  closeInactive: z.object({
    enabled: z.boolean(),
    hours: z.number().int().min(CLOSE_INACTIVE_HOURS.min).max(CLOSE_INACTIVE_HOURS.max),
    sendClosingMessage: z.boolean(),
  }),
});

/** settings 'auto_rules' (spec 2026-10-20 agendamentos §4); the defaults (both off) when the key is missing or invalid. */
export async function getAutoRules(db: Db | Tx): Promise<AutoRulesDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'auto_rules'));
  const parsed = AutoRulesBody.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_AUTO_RULES;
}
```

In `registerSettingsRoutes`, after `app.get('/api/settings', async () => readSettings(ctx.db));`, add:

```ts
  // Own route (spec §5): PUT /api/settings replaces the whole SettingsDto and must never switch the rules off.
  app.get('/api/settings/auto-rules', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    return getAutoRules(ctx.db);
  });

  app.put('/api/settings/auto-rules', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const value = AutoRulesBody.parse(req.body);
    await ctx.db
      .insert(settings)
      .values({ key: 'auto_rules', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    return getAutoRules(ctx.db);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/catalog/settings.ts server/test/catalog/settings.test.ts
git commit -m "feat(server): automatic rules settings (admin), off by default" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The two rules and the worker

Each rule is one batched `SELECT` and then one existing-style `updateChat` per chat, with `authorId: null`. The `WHERE` of each `UPDATE` re-checks the condition, so whoever acted in between wins: `409 STALE` becomes `false`. "Devolver à fila" never needs a column of its own. The N minutes count from the newest of `waiting_since` and the last owner-giving event (`created`, `assigned`, `transferred`, `bot_transferred`). A returned chat has no owner, so it is out until someone takes it, and that "assigned" restarts the count (Review Focus 3).

**Clock note for the tests:** `addEvent` stamps events with the DB's `clock_timestamp()` (real time), while the rules compare against `ctx.botRuntime.now()`. The rule tests therefore set `ctx.clock.set(new Date())` in `beforeEach` and seed every other time relative to it.

**Files:**
- Modify: `server/src/inbox/chats.ts` (append `returnChatToQueue`, `closeChatForInactivity`)
- Create: `server/src/automation/rules.ts`, `server/src/automation/worker.ts`
- Modify: `server/src/index.ts` (import, start, stop)
- Test: `server/test/automation/rules.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 `OPEN_STATUSES`, `insertScheduled`, `runningBot`; Task 3 `deliverDueScheduled`; Task 4 `getAutoRules`; existing `updateChat`, `sendSystemMessage`, `getClosingMessage`, `errorTag`, `NON_TERMINAL_RUN_STATES`.
- Produces: `returnChatToQueue`, `closeChatForInactivity`, `runAutoRules`, `createAutomationWorker`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/automation/rules.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTO_RULES, type AutoRulesDto } from '@talk/shared';
import { runAutoRules } from '../../src/automation/rules.js';
import { createAutomationWorker } from '../../src/automation/worker.js';
import { chats, messages, scheduledMessages, settings } from '../../src/db/schema.js';
import { assumeChat } from '../../src/inbox/chats.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { seedChat, type SeedChatOpts } from '../chats/seed.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { insertScheduled, runningBot } from './seed.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const hooks: IngestHooks = { startTriage: async () => {}, handleTriageReply: async () => false };

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ctx.clock.set(new Date()); // events carry the DB's clock_timestamp(): keep the fake clock on real time
});
afterEach(() => vi.restoreAllMocks());

const ago = (ms: number) => new Date(ctx.clock.now().getTime() - ms);
const run = () => runAutoRules(ctx, ctx.clock.now());
const chatRow = async (id: string) => (await ctx.db.select().from(chats).where(eq(chats.id, id)))[0]!;
const texts = () => ctx.wa.sent.filter((x) => x.method === 'sendText');
let phoneSeq = 0;
const chat = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: `55659900000${String(++phoneSeq).padStart(2, '0')}`, ...o,
  });

async function setRules(r: { returnToQueue?: Partial<AutoRulesDto['returnToQueue']>; closeInactive?: Partial<AutoRulesDto['closeInactive']> }) {
  const value: AutoRulesDto = {
    returnToQueue: { ...DEFAULT_AUTO_RULES.returnToQueue, ...r.returnToQueue },
    closeInactive: { ...DEFAULT_AUTO_RULES.closeInactive, ...r.closeInactive },
  };
  await ctx.db.insert(settings).values({ key: 'auto_rules', value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

function inbound(phone: string): Extract<InboundEvent, { type: 'message' }> {
  const externalId = `IN-${randomUUID()}`;
  return {
    type: 'message', instance: s.instance, externalId, direction: 'in', phone, lid: null, pushName: 'Maria Cliente', kind: 'text',
    body: 'Ainda preciso de ajuda', hasMedia: false, mediaMime: null, mediaName: null, replyToExternalId: null, sentAt: new Date(),
    raw: { key: { id: externalId } },
  };
}

describe('"Devolver à fila conversas paradas" (spec 2026-10-20 agendamentos §4.1)', () => {
  const waitingFor = (ms: number): Partial<SeedChatOpts> => ({ waiting: true, waitingSince: ago(ms), at: ago(ms) });

  it('is off by default', async () => {
    await chat(waitingFor(2 * HOUR));
    expect(await run()).toEqual({ returned: 0, closed: 0 });
  });

  it('takes the owner away from a chat whose contact waits past N minutes, once, and says why', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const { chatId } = await chat(waitingFor(31 * MIN));
    const fresh = await chat(waitingFor(29 * MIN));

    expect(await run()).toEqual({ returned: 1, closed: 0 });
    expect(await chatRow(chatId)).toMatchObject({ ownerId: null, sectorId: s.sectorA, state: 'open', waiting: true });
    expect((await chatRow(fresh.chatId)).ownerId).toBe(s.agentA.id);
    expect(await eventsOf(ctx, chatId)).toMatchObject([
      { kind: 'returned_to_queue', data: { minutes: 30, previousOwnerId: s.agentA.id }, authorId: null },
    ]);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    expect(await run()).toEqual({ returned: 0, closed: 0 }); // once per wait: it has no owner now
  });

  it('a wait from before waiting_since existed counts from the last message', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const { chatId } = await chat({ waiting: true, waitingSince: null, at: ago(31 * MIN) });
    expect((await run()).returned).toBe(1);
    expect((await chatRow(chatId)).ownerId).toBeNull();
  });

  it('the count starts again when someone takes the chat (Review Focus 3)', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const { chatId } = await chat({ ...waitingFor(2 * HOUR), ownerId: null });
    await assumeChat(ctx, s.agentA, chatId);
    expect((await run()).returned).toBe(0);
    ctx.clock.advance(31 * MIN);
    expect((await run()).returned).toBe(1);
    expect((await chatRow(chatId)).ownerId).toBeNull();
  });

  it('leaves private, unowned, answered, triage and chatbot chats alone', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const priv = await chat({ ...waitingFor(2 * HOUR), private: true });
    await chat({ ...waitingFor(2 * HOUR), ownerId: null });
    const answered = await chat({ at: ago(2 * HOUR) });
    const triage = await chat(waitingFor(2 * HOUR));
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, triage.chatId));
    const bot = await chat(waitingFor(2 * HOUR));
    await runningBot(ctx, bot.chatId, bot.contactId);

    expect((await run()).returned).toBe(0);
    for (const c of [priv, answered, triage, bot]) expect((await chatRow(c.chatId)).ownerId).toBe(s.agentA.id);
  });
});

describe('"Finalizar por inatividade" (spec 2026-10-20 agendamentos §4.2)', () => {
  beforeEach(async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Atendimento encerrado. Obrigado!' });
  });

  it('closes a chat where the office spoke last over N hours ago, sending the closing message as the system', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: true } });
    const { chatId } = await chat({ at: ago(25 * HOUR) });
    const recent = await chat({ at: ago(23 * HOUR) });

    expect(await run()).toEqual({ returned: 0, closed: 1 });
    expect(await chatRow(chatId)).toMatchObject({ state: 'closed', waiting: false });
    expect((await chatRow(recent.chatId)).state).toBe('open');
    expect(texts().map((x) => (x.payload as { text: string }).text)).toEqual(['Atendimento encerrado. Obrigado!']);
    expect((await ctx.db.select().from(messages).where(eq(messages.chatId, chatId)))[0]).toMatchObject({ direction: 'out', authorId: null, status: 'sent' });
    expect((await eventsOf(ctx, chatId)).at(-1)).toMatchObject({
      kind: 'closed', authorId: null, data: { closingMessageSent: true, reason: 'inactivity', hours: 24 },
    });
  });

  it('closes without a message when the box is off', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const { chatId } = await chat({ at: ago(25 * HOUR) });
    expect((await run()).closed).toBe(1);
    expect(texts()).toEqual([]);
    expect((await eventsOf(ctx, chatId)).at(-1)).toMatchObject({ kind: 'closed', data: { closingMessageSent: false, reason: 'inactivity' } });
  });

  it('leaves waiting, chatbot and scheduled chats alone, and closes private ones (Review Focus 7)', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const waiting = await chat({ at: ago(25 * HOUR), waiting: true, waitingSince: ago(25 * HOUR) });
    const bot = await chat({ at: ago(25 * HOUR) });
    await runningBot(ctx, bot.chatId, bot.contactId);
    const scheduled = await chat({ at: ago(25 * HOUR) });
    await insertScheduled(ctx, { chatId: scheduled.chatId, authorId: s.agentA.id, sendAt: ago(-HOUR) });
    const priv = await chat({ at: ago(25 * HOUR), private: true });

    expect((await run()).closed).toBe(1);
    expect((await chatRow(priv.chatId)).state).toBe('closed');
    for (const c of [waiting, bot, scheduled]) expect((await chatRow(c.chatId)).state).toBe('open');
  });

  it('a failed closing message keeps the chat open and the next beat leaves it alone (Review Focus 4)', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: true } });
    const { chatId } = await chat({ at: ago(25 * HOUR) });
    ctx.wa.failNext();
    expect((await run()).closed).toBe(0);
    expect((await chatRow(chatId)).state).toBe('open');
    expect((await ctx.db.select().from(messages).where(eq(messages.chatId, chatId)))[0]).toMatchObject({ status: 'failed' });
    expect((await run()).closed).toBe(0); // the failed message is the chat's last message now
    expect(texts()).toEqual([]);
  });

  it('a contact writing while the closing message goes out keeps the chat open (Review Focus 4)', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: true } });
    const { chatId } = await chat({ at: ago(25 * HOUR), phone: '5565988887777' });
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      await handleInbound(ctx, [inbound('5565988887777')], hooks);
      return res;
    });
    expect((await run()).closed).toBe(0);
    expect(await chatRow(chatId)).toMatchObject({ state: 'open', waiting: true });
  });
});

describe('createAutomationWorker', () => {
  it('runs the scheduled-message beat and the rules beat until stopped', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const idle = await chat({ at: ago(25 * HOUR) });
    const target = await chat();
    const row = await insertScheduled(ctx, { chatId: target.chatId, authorId: s.agentA.id, sendAt: ago(MIN) });
    const worker = createAutomationWorker(ctx, { scheduledMs: 10, rulesMs: 10 });
    worker.start();
    try {
      await vi.waitFor(async () => {
        expect((await chatRow(idle.chatId)).state).toBe('closed');
        expect((await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id)))[0]!.status).toBe('sent');
      }, { timeout: 5000 });
    } finally {
      worker.stop();
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/automation/rules.test.ts`
Expected: FAIL. `../../src/automation/rules.js` does not exist.

- [ ] **Step 3: Add the two system actions**

Append to the end of `server/src/inbox/chats.ts`:

```ts
// ---------- automatic rules (spec 2026-10-20 agendamentos §4) ----------
// The system acts: no canSee, events without author. Each UPDATE re-checks the condition the rule selected on, so a
// contact or an agent acting in between wins: the 409 STALE becomes `false` and nothing changes.

async function unlessStale(change: () => Promise<unknown>): Promise<boolean> {
  try {
    await change();
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return false;
    throw e;
  }
}

/** "Devolver à fila": the waiting chat loses its owner, back to "Sem atendente" in the same sector. */
export async function returnChatToQueue(ctx: AppCtx, chatId: string, ownerId: string, minutes: number): Promise<boolean> {
  return unlessStale(() =>
    updateChat(
      ctx,
      chatId,
      and(eq(chats.state, 'open'), eq(chats.waiting, true), eq(chats.private, false), eq(chats.ownerId, ownerId)),
      { ownerId: null },
      { kind: 'returned_to_queue', data: { minutes, previousOwnerId: ownerId }, authorId: null },
    ),
  );
}

/**
 * "Finalizar por inatividade": the closing text (if any) goes first as a system message, without author or signature.
 * A gateway failure keeps the chat open with the failed bubble; a contact without an address is closed without it.
 */
export async function closeChatForInactivity(
  ctx: AppCtx,
  chatId: string,
  opts: { closingText: string | null; hours: number },
): Promise<boolean> {
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  if (!chat || chat.state !== 'open' || chat.waiting) return false;
  let closingMessageSent = false;
  if (opts.closingText) {
    const sent = await sendSystemMessage(ctx, chat, { text: opts.closingText });
    if (!sent.ok && sent.messageId !== null) {
      await ctx.hub.publishChat(chatId); // the failed bubble is the chat's last message now
      return false;
    }
    closingMessageSent = sent.ok;
  }
  return unlessStale(() =>
    updateChat(
      ctx,
      chatId,
      and(eq(chats.state, 'open'), eq(chats.waiting, false)), // the contact wrote meanwhile: keep it open
      { state: 'closed', closedAt: new Date(), waiting: false, waitingSince: null, triagePending: false },
      { kind: 'closed', data: { closingMessageSent, reason: 'inactivity', hours: opts.hours }, authorId: null },
    ),
  );
}
```

- [ ] **Step 4: Write the rules**

Create `server/src/automation/rules.ts`:

```ts
// Spec 2026-10-20 agendamentos §4: the two automatic rules, batched. The selection is a hint; the UPDATE in
// returnChatToQueue / closeChatForInactivity re-checks it, so running twice (or racing an agent) never repeats an effect.
import { and, asc, eq, gte, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import { NON_TERMINAL_RUN_STATES } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import { getAutoRules } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import { botRuns, chatEvents, chats, scheduledMessages } from '../db/schema.js';
import { closeChatForInactivity, getClosingMessage, returnChatToQueue } from '../inbox/chats.js';
import { OPEN_STATUSES } from './scheduled.js';

const BATCH = 50;
/** Events that give the chat an owner: "Devolver à fila" counts from the newest of them (spec §4.1). */
const OWNER_EVENTS = ['created', 'assigned', 'transferred', 'bot_transferred'] as const;

const one = sql`1`;

function noRunningBot(ctx: AppCtx) {
  return notExists(
    ctx.db.select({ one }).from(botRuns).where(and(eq(botRuns.chatId, chats.id), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES]))),
  );
}

async function returnStaleChats(ctx: AppCtx, minutes: number, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = await ctx.db
    .select({ id: chats.id, ownerId: chats.ownerId })
    .from(chats)
    .where(
      and(
        eq(chats.state, 'open'),
        eq(chats.waiting, true),
        eq(chats.private, false),
        eq(chats.history, false),
        eq(chats.triagePending, false),
        isNotNull(chats.ownerId),
        // a chat that waited from before waiting_since existed counts from its last message (spec 2026-10-20 lista §3)
        sql`coalesce(${chats.waitingSince}, ${chats.lastMessageAt}, ${chats.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
        // whoever took it last gets the whole N minutes
        notExists(
          ctx.db
            .select({ one })
            .from(chatEvents)
            .where(and(eq(chatEvents.chatId, chats.id), inArray(chatEvents.kind, [...OWNER_EVENTS]), gte(chatEvents.createdAt, cutoff))),
        ),
        noRunningBot(ctx),
      ),
    )
    .orderBy(asc(chats.id))
    .limit(BATCH);
  let returned = 0;
  for (const r of rows) {
    try {
      if (await returnChatToQueue(ctx, r.id, r.ownerId!, minutes)) returned += 1;
    } catch (err) {
      console.error('auto rule failed', { rule: 'return_to_queue', chatId: r.id, err: errorTag(err) });
    }
  }
  return returned;
}

async function closeInactiveChats(ctx: AppCtx, hours: number, sendClosingMessage: boolean, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const rows = await ctx.db
    .select({ id: chats.id })
    .from(chats)
    .where(
      and(
        eq(chats.state, 'open'),
        eq(chats.waiting, false),
        eq(chats.history, false),
        eq(chats.triagePending, false),
        sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
        noRunningBot(ctx), // the chatbot has its own inactivity
        notExists(
          ctx.db
            .select({ one })
            .from(scheduledMessages)
            .where(and(eq(scheduledMessages.chatId, chats.id), inArray(scheduledMessages.status, OPEN_STATUSES))),
        ),
      ),
    )
    .orderBy(asc(chats.id))
    .limit(BATCH);
  const closingText = sendClosingMessage ? (await getClosingMessage(ctx.db)) || null : null;
  let closed = 0;
  for (const r of rows) {
    try {
      if (await closeChatForInactivity(ctx, r.id, { closingText, hours })) closed += 1;
    } catch (err) {
      console.error('auto rule failed', { rule: 'close_inactive', chatId: r.id, err: errorTag(err) });
    }
  }
  return closed;
}

/** One beat of both rules (each only when an admin turned it on). */
export async function runAutoRules(ctx: AppCtx, now: Date = ctx.botRuntime.now()): Promise<{ returned: number; closed: number }> {
  const rules = await getAutoRules(ctx.db);
  const returned = rules.returnToQueue.enabled ? await returnStaleChats(ctx, rules.returnToQueue.minutes, now) : 0;
  const closed = rules.closeInactive.enabled
    ? await closeInactiveChats(ctx, rules.closeInactive.hours, rules.closeInactive.sendClosingMessage, now)
    : 0;
  if (returned || closed) console.info('auto rules', { returned, closed });
  return { returned, closed };
}
```

- [ ] **Step 5: Write the worker and start it**

Create `server/src/automation/worker.ts`:

```ts
// Spec 2026-10-20 agendamentos: one module, two beats. Scheduled messages every 15 s (a minute-precise time goes out within
// seconds), the automatic rules every minute. A beat that is still draining makes the next one skip.
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { deliverDueScheduled } from './delivery.js';
import { runAutoRules } from './rules.js';

export function createAutomationWorker(ctx: AppCtx, opts: { scheduledMs?: number; rulesMs?: number } = {}) {
  const timers: Array<ReturnType<typeof setInterval>> = [];

  function every(ms: number, label: string, beat: () => Promise<unknown>): void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      beat()
        .catch((err: unknown) => console.error(label, errorTag(err)))
        .finally(() => {
          busy = false;
        });
    }, ms);
    timer.unref();
    timers.push(timer);
  }

  return {
    start(): void {
      if (timers.length) return;
      every(opts.scheduledMs ?? 15_000, 'scheduled messages beat failed', () => deliverDueScheduled(ctx));
      every(opts.rulesMs ?? 60_000, 'auto rules beat failed', () => runAutoRules(ctx));
    },
    stop(): void {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}
```

In `server/src/index.ts`, after `import { createHistoryWorker } from './history/jobs.js';`, add:

```ts
import { createAutomationWorker } from './automation/worker.js';
```

replace

```ts
const history = createHistoryWorker(ctx);
history.start();
```

with

```ts
const history = createHistoryWorker(ctx);
history.start();

// Spec 2026-10-20 agendamentos: due scheduled messages (every 15 s) and the automatic rules (every minute). State lives
// in the DB; a row a restart left in 'sending' fails after 10 min instead of going out again.
const automation = createAutomationWorker(ctx);
automation.start();
```

and replace

```ts
    void history.stop();
```

with

```ts
    void history.stop();
    automation.stop();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/automation test/inbox test/chats`
Expected: PASS.

Run: `npm test -w server` and `npm run typecheck -w server`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/inbox/chats.ts server/src/automation/rules.ts server/src/automation/worker.ts server/src/index.ts server/test/automation/rules.test.ts
git commit -m "feat(server): automatic rules (devolver à fila, finalizar por inatividade) and the automation worker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web client, the "Agendada" mark and the failure toast

**Files:**
- Modify: `web/src/lib/api.ts` (type imports, `ScheduleInput`, `api.scheduled`, `api.settings.autoRules`, `qk`)
- Modify: `web/src/components/layout/NotificationToasts.tsx`
- Modify: `web/src/components/conversation/MessageBubble.tsx` (icon import, the mark)
- Test: `web/src/lib/api.test.ts`, `web/src/components/layout/NotificationToasts.test.tsx`, `web/src/components/conversation/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: Task 1 DTOs; the Task 2 and Task 4 routes.
- Produces: everything under `web/src/lib/api.ts` in the Shared contract (used by Tasks 7–9).

- [ ] **Step 1: Write the failing tests**

In `web/src/lib/api.test.ts`, replace

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
```

with

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTO_RULES } from '@talk/shared';
```

and add at the end of the file:

```ts
describe('api routes of the 2026-10-20 agendamentos delivery', () => {
  it('calls the scheduled-message and auto-rule routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await api.scheduled.listForChat('c1');
    await api.scheduled.list('failed');
    await api.scheduled.create('c1', { text: 'Oi', sendAt: '2026-10-21T12:00:00.000Z', signature: true });
    await api.scheduled.update('s1', { sendAt: '2026-10-21T13:00:00.000Z' });
    await api.scheduled.cancel('s1');
    await api.settings.autoRules.get();
    await api.settings.autoRules.put(DEFAULT_AUTO_RULES);
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)} ${String(i?.body ?? '')}`)).toEqual([
      'GET /api/chats/c1/scheduled-messages ',
      'GET /api/scheduled-messages?status=failed ',
      'POST /api/chats/c1/scheduled-messages {"text":"Oi","sendAt":"2026-10-21T12:00:00.000Z","signature":true}',
      'PATCH /api/scheduled-messages/s1 {"sendAt":"2026-10-21T13:00:00.000Z"}',
      'POST /api/scheduled-messages/s1/cancel ',
      'GET /api/settings/auto-rules ',
      `PUT /api/settings/auto-rules ${JSON.stringify(DEFAULT_AUTO_RULES)}`,
    ]);
  });

  it('sends a scheduled attachment as multipart, with the fields before the file', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF'], 'peticao.pdf', { type: 'application/pdf' });
    await api.scheduled.create('c1', { text: 'Segue', sendAt: '2026-10-21T12:00:00.000Z', signature: false, file });
    const body = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect([...body.keys()]).toEqual(['text', 'sendAt', 'signature', 'file']);
    expect(body.get('signature')).toBe('false');
    expect((body.get('file') as File).name).toBe('peticao.pdf');
  });
});
```

In `web/src/components/layout/NotificationToasts.test.tsx`, replace

```tsx
          <Route path="/chats/:id" element={<p>Conversa aberta</p>} />
```

with

```tsx
          <Route path="/chats/:id" element={<p>Conversa aberta</p>} />
          <Route path="/agendamentos" element={<p>Página de agendamentos</p>} />
```

and add inside `describe('NotificationToasts', …)`, after the first test:

```tsx
  it('a failed scheduled message says so and opens Agendamentos → Falharam (spec 2026-10-20 agendamentos §3.3)', () => {
    setup('default');
    emit({
      type: 'notification',
      notification: { ...NOTE, id: 'n2', kind: 'scheduled_failed', title: 'Mensagem agendada não enviada', text: 'Erro inesperado', botName: '' },
    });
    expect(screen.getByText('Mensagens agendadas')).toBeTruthy();
    expect(screen.queryByText(/Chatbot/)).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /Mensagem agendada não enviada/ }));
    expect(screen.getByText('Página de agendamentos')).toBeTruthy();
  });
```

In `web/src/components/conversation/MessageBubble.test.tsx`, add at the end of the file:

```tsx
describe('MessageBubble scheduled mark (spec 2026-10-20 agendamentos §3.3)', () => {
  it('a scheduled message says "Agendada"; any other does not', () => {
    expect(renderBubble({ ...base, scheduled: true }).querySelector('[data-tag="scheduled"]')?.textContent).toContain('Agendada');
    cleanup();
    expect(renderBubble(base).querySelector('[data-tag="scheduled"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/lib/api.test.ts src/components/layout/NotificationToasts.test.tsx src/components/conversation/MessageBubble.test.tsx`
Expected: FAIL. `api.scheduled` is undefined, the toast reads "Chatbot " and links to `/chats/c1`, and there is no `[data-tag="scheduled"]`.

- [ ] **Step 3: Add the client calls and query keys**

In `web/src/lib/api.ts`, in the `@talk/shared` type import list, add `AutoRulesDto,` after `import type {`, and add `ScheduledMessageDto,` and `ScheduledTab,` after `SaveVersionInput,`.

After `export interface BulkTransferInput { chatIds: string[]; sectorId?: string; ownerId?: string | null }`, add:

```ts
/** Spec 2026-10-20 agendamentos §3.1: `sendAt` is an ISO instant; at most one file, kept until it is sent. */
export interface ScheduleInput { text: string; sendAt: string; signature: boolean; file?: Blob; fileName?: string }
```

Replace

```ts
  settings: {
    get: () => request<SettingsDto>('GET', '/api/settings'),
    put: (s: SettingsDto) => request<SettingsDto>('PUT', '/api/settings', s),
  },
```

with

```ts
  settings: {
    get: () => request<SettingsDto>('GET', '/api/settings'),
    put: (s: SettingsDto) => request<SettingsDto>('PUT', '/api/settings', s),
    /** Spec 2026-10-20 agendamentos §4 (admin): its own route, apart from the whole-settings PUT. */
    autoRules: {
      get: () => request<AutoRulesDto>('GET', '/api/settings/auto-rules'),
      put: (rules: AutoRulesDto) => request<AutoRulesDto>('PUT', '/api/settings/auto-rules', rules),
    },
  },
  scheduled: {
    /** The chat's pending ones (spec 2026-10-20 agendamentos §3.2). */
    listForChat: (chatId: string) => request<ScheduledMessageDto[]>('GET', `/api/chats/${enc(chatId)}/scheduled-messages`),
    /** Mine (an admin: everyone's), one tab at a time. */
    list: (status: ScheduledTab) => request<ScheduledMessageDto[]>('GET', `/api/scheduled-messages${qs({ status })}`),
    create: (chatId: string, input: ScheduleInput) => {
      const path = `/api/chats/${enc(chatId)}/scheduled-messages`;
      if (!input.file) return request<ScheduledMessageDto>('POST', path, { text: input.text, sendAt: input.sendAt, signature: input.signature });
      // @fastify/multipart only exposes fields that come BEFORE the file part — keep the file last.
      const form = new FormData();
      form.append('text', input.text);
      form.append('sendAt', input.sendAt);
      form.append('signature', String(input.signature));
      form.append('file', input.file, input.fileName ?? (input.file instanceof File ? input.file.name : 'arquivo'));
      return request<ScheduledMessageDto>('POST', path, form);
    },
    update: (id: string, patch: { text?: string; sendAt?: string }) =>
      request<ScheduledMessageDto>('PATCH', `/api/scheduled-messages/${enc(id)}`, patch),
    cancel: (id: string) => request<ScheduledMessageDto>('POST', `/api/scheduled-messages/${enc(id)}/cancel`),
  },
```

In `qk`, replace

```ts
  settings: ['settings'] as const,
```

with

```ts
  settings: ['settings'] as const,
  autoRules: ['settings', 'auto-rules'] as const,
  /** Every scheduled-message list (prefix). Under ['chats'] so the WS reconnect invalidation refreshes them too. */
  scheduled: ['chats', 'scheduled'] as const,
  chatScheduled: (chatId: string) => ['chats', 'scheduled', 'chat', chatId] as const,
  scheduledList: (tab: ScheduledTab) => ['chats', 'scheduled', 'list', tab] as const,
```

- [ ] **Step 4: The failure toast**

In `web/src/components/layout/NotificationToasts.tsx`, replace

```tsx
const titleOf = (n: NotificationDto) => n.title.trim() || 'Notificação do chatbot';
```

with

```tsx
const titleOf = (n: NotificationDto) => n.title.trim() || 'Notificação do chatbot';
/** Spec 2026-10-20 agendamentos §3.3: a failed scheduled message opens "Agendamentos → Falharam"; a bot's notice, its chat. */
const targetOf = (n: NotificationDto) => (n.kind === 'scheduled_failed' ? '/agendamentos?status=failed' : `/chats/${n.chatId}`);
const footerOf = (n: NotificationDto) => (n.kind === 'scheduled_failed' ? 'Mensagens agendadas' : `Chatbot ${n.botName}`);
```

replace

```tsx
      showBrowserNotification(titleOf(n), n.text, n.id, () => navigate(`/chats/${n.chatId}`));
```

with

```tsx
      showBrowserNotification(titleOf(n), n.text, n.id, () => navigate(targetOf(n)));
```

replace

```tsx
          to={`/chats/${n.chatId}`}
```

with

```tsx
          to={targetOf(n)}
```

and replace

```tsx
          <p className="mt-1 text-xs text-muted">Chatbot {n.botName}</p>
```

with

```tsx
          <p className="mt-1 text-xs text-muted">{footerOf(n)}</p>
```

- [ ] **Step 5: The "Agendada" mark**

In `web/src/components/conversation/MessageBubble.tsx`, replace

```tsx
import { Check, Checks, Clock, DownloadSimple, FileText, ImageBroken, Robot, ShareFat, Star, WarningCircle } from '@phosphor-icons/react';
```

with

```tsx
import {
  CalendarCheck, Check, Checks, Clock, DownloadSimple, FileText, ImageBroken, Robot, ShareFat, Star, WarningCircle,
} from '@phosphor-icons/react';
```

and replace

```tsx
            <ShareFat size={12} aria-hidden /> Encaminhada
          </p>
        )}
```

with

```tsx
            <ShareFat size={12} aria-hidden /> Encaminhada
          </p>
        )}
        {m.scheduled && (
          <p data-tag="scheduled" className="mb-1 flex items-center gap-1 text-xs italic opacity-70">
            <CalendarCheck size={12} aria-hidden /> Agendada
          </p>
        )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w web -- src/lib/api.test.ts src/components/layout/NotificationToasts.test.tsx src/components/conversation/MessageBubble.test.tsx`
Expected: PASS, including the existing toast tests: a bot notice still reads "Chatbot Fluxo do escritório" and opens its chat.

Run: `npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/components/layout/NotificationToasts.tsx web/src/components/layout/NotificationToasts.test.tsx web/src/components/conversation/MessageBubble.tsx web/src/components/conversation/MessageBubble.test.tsx
git commit -m "feat(web): scheduled-message client, the Agendada mark and the failure toast" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Schedule from the composer, and the chat's strip

**Files:**
- Create: `web/src/components/conversation/Scheduled.tsx`
- Modify: `web/src/components/conversation/Composer.tsx` (imports, state, `openSchedule`, `schedule`, button, dialog)
- Modify: `web/src/components/conversation/ConversationView.tsx` (import, `useWsEvent`, strip)
- Test: `web/src/components/conversation/Scheduled.test.tsx` (create), `web/src/components/conversation/Composer.test.tsx`

**Interfaces:**
- Consumes: Task 1 helpers; Task 6 `api.scheduled`, `qk.scheduled`, `qk.chatScheduled`; existing `Modal`, `Actions`, `confirmDialog`, `errorMessage`, `contactLabel`.
- Produces: `ScheduleDialog`, `ScheduledItem`, `ScheduledStrip`, `scheduledCount` and `STATUS_LABELS` (Task 8 reuses `ScheduledItem`).

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/conversation/Scheduled.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ScheduledMessageDto } from '@talk/shared';
import { confirmDialog } from '../../lib/confirm';
import { ScheduleDialog, ScheduledStrip } from './Scheduled';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));

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

function item(over: Partial<ScheduledMessageDto> = {}): ScheduledMessageDto {
  return {
    id: 's1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
    body: 'Lembrete: audiência amanhã às 9h', signature: false, attachment: null, sendAt: '2026-10-21T12:00:00.000Z', status: 'pending',
    error: null, messageId: null, sentChatId: null, createdAt: '2026-10-20T12:00:00.000Z', finishedAt: null, canEdit: true, ...over,
  };
}

function renderStrip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ScheduledStrip chatId="c1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z')); // 08:00 in Cuiabá
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(confirmDialog).mockClear();
});

describe('ScheduleDialog (spec 2026-10-20 agendamentos §3.1)', () => {
  it('reads the time as Cuiabá time, refuses less than 2 minutes ahead and hands back an ISO instant (Review Focus 5)', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ScheduleDialog title="Agendar mensagem" confirmLabel="Agendar" initialText="Lembrete" onCancel={() => {}} onConfirm={onConfirm} />);
    const when = screen.getByLabelText('Data e hora (horário de Cuiabá)') as HTMLInputElement;
    expect(when.min).toBe('2026-10-20T08:02');

    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Escolha a data e a hora');
    fireEvent.change(when, { target: { value: '2026-10-20T08:01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Escolha um horário pelo menos 2 minutos à frente'));
    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: '   ' } });
    fireEvent.change(when, { target: { value: '2026-10-20T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Digite a mensagem'));

    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: ' Lembrete ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Lembrete', '2026-10-20T13:30:00.000Z'));
  });

  it('an edit that keeps the time sends only the text, even when that time is now under 2 minutes away', async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <ScheduleDialog
        title="Editar agendamento" confirmLabel="Salvar" initialText="Lembrete" initialSendAt="2026-10-20T12:01:00.000Z"
        fileName="peticao.pdf" onCancel={() => {}} onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('Anexo: peticao.pdf')).toBeTruthy();
    expect((screen.getByLabelText('Data e hora (horário de Cuiabá)') as HTMLInputElement).value).toBe('2026-10-20T08:01');
    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: 'Lembrete corrigido' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Lembrete corrigido', undefined));
  });
});

describe('ScheduledStrip (spec §3.2)', () => {
  it('shows the count and, opened, Editar/Cancelar only where the user may change it', async () => {
    stubFetch({
      'GET /api/chats/c1/scheduled-messages': [
        item(),
        item({ id: 's2', authorName: 'Bruno', canEdit: false, attachment: { name: 'a.pdf', mime: 'application/pdf', size: 3 } }),
      ],
    });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '2 mensagens agendadas' }));
    expect(screen.getAllByText('21/10/2026 08:00')).toHaveLength(2);
    expect(screen.getByText('por Bruno', { exact: false })).toBeTruthy();
    expect(screen.getByText('Anexo')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Editar' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(1);
  });

  it('shows nothing without pending messages', async () => {
    stubFetch({ 'GET /api/chats/c1/scheduled-messages': [] });
    renderStrip();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('cancels after confirming', async () => {
    stubFetch({
      'GET /api/chats/c1/scheduled-messages': [item()],
      'POST /api/scheduled-messages/s1/cancel': item({ status: 'canceled', canEdit: false }),
    });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '1 mensagem agendada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/scheduled-messages/s1/cancel')).toBe(true));
    expect(confirmDialog).toHaveBeenCalledWith({ title: 'Cancelar a mensagem agendada?', confirmLabel: 'Cancelar agendamento' });
  });

  it('edits through the dialog with PATCH', async () => {
    stubFetch({
      'GET /api/chats/c1/scheduled-messages': [item()],
      'PATCH /api/scheduled-messages/s1': item({ body: 'Novo texto' }),
    });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '1 mensagem agendada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: 'Novo texto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ text: 'Novo texto' }));
  });
});
```

In `web/src/components/conversation/Composer.test.tsx`, replace

```tsx
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
```

with

```tsx
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
```

and add inside `describe('Composer', …)`, after the first test:

```tsx
  it('Agendar mensagem asks for a text first, then schedules it with the signature choice and clears the box (spec 2026-10-20 agendamentos §3.1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    stubFetch({ 'POST /api/chats/c1/scheduled-messages': {} });
    renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Agendar mensagem' }));
    expect(screen.getByRole('alert').textContent).toBe('Digite a mensagem que será agendada');

    fireEvent.change(box(), { target: { value: 'Lembrete da audiência' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar mensagem' }));
    expect((screen.getByLabelText('Texto da mensagem') as HTMLTextAreaElement).value).toBe('Lembrete da audiência');
    fireEvent.change(screen.getByLabelText('Data e hora (horário de Cuiabá)'), { target: { value: '2026-10-21T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));

    await waitFor(() => expect(posts('/api/chats/c1/scheduled-messages')).toHaveLength(1));
    expect(posts('/api/chats/c1/scheduled-messages')[0]!.body).toEqual({
      text: 'Lembrete da audiência', sendAt: '2026-10-21T13:00:00.000Z', signature: true,
    });
    await waitFor(() => expect(box().value).toBe(''));
    expect(posts('/api/chats/c1/messages')).toEqual([]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/Scheduled.test.tsx src/components/conversation/Composer.test.tsx`
Expected: FAIL. `./Scheduled` does not exist, and the composer has no "Agendar mensagem" button.

- [ ] **Step 3: Write the components**

Create `web/src/components/conversation/Scheduled.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Paperclip } from '@phosphor-icons/react';
import {
  SCHEDULE_MAX_AHEAD_MS, SCHEDULE_MIN_LEAD_MS, SCHEDULE_TEXT_MAX, formatOfficeDateTime, isoToOfficeLocal, officeLocalToIso,
  scheduleTimeProblem, type ScheduledMessageDto, type ScheduledStatus,
} from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { contactLabel } from '../../lib/format';
import { Actions, Modal } from './ChatDialogs';
import { errorMessage } from './model';

export const scheduledCount = (n: number) => (n === 1 ? '1 mensagem agendada' : `${n} mensagens agendadas`);

export const STATUS_LABELS: Record<ScheduledStatus, string> = {
  pending: 'Pendente', sending: 'Enviando…', sent: 'Enviada', failed: 'Falhou', canceled: 'Cancelada',
};

const field = 'mt-1 block w-full rounded border border-field bg-surface px-2 py-1.5 text-sm text-fg';

/**
 * "Agendar mensagem" / "Editar agendamento" (spec 2026-10-20 agendamentos §3.1–3.2). The time is typed in Cuiabá time.
 * `onConfirm` gets the trimmed text and an ISO instant, or undefined for an edit that kept the time. A kept time is not
 * checked again: it may be under 2 minutes away by now. It throws to show its error here.
 */
export function ScheduleDialog(props: {
  title: string;
  confirmLabel: string;
  initialText: string;
  initialSendAt?: string;
  fileName?: string;
  onCancel: () => void;
  onConfirm: (text: string, sendAt: string | undefined) => Promise<unknown>;
}) {
  const initialLocal = props.initialSendAt ? isoToOfficeLocal(props.initialSendAt) : '';
  const [text, setText] = useState(props.initialText);
  const [local, setLocal] = useState(initialLocal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  async function confirm() {
    const value = text.trim();
    if (!value) return setError('Digite a mensagem');
    const kept = props.initialSendAt !== undefined && local === initialLocal;
    const iso = officeLocalToIso(local);
    if (!kept) {
      const problem = scheduleTimeProblem(iso ? new Date(iso) : null, new Date());
      if (problem) return setError(problem);
    }
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(value, kept ? undefined : (iso ?? undefined));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={props.title} onCancel={props.onCancel}>
      <label className="block text-sm font-medium">
        Texto da mensagem
        <textarea rows={4} maxLength={SCHEDULE_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} className={field} />
      </label>
      {props.fileName && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
          <Paperclip size={14} aria-hidden /> Anexo: {props.fileName}
        </p>
      )}
      <label className="mt-3 block text-sm font-medium">
        Data e hora (horário de Cuiabá)
        <input
          type="datetime-local"
          value={local}
          min={isoToOfficeLocal(new Date(now + SCHEDULE_MIN_LEAD_MS).toISOString())}
          max={isoToOfficeLocal(new Date(now + SCHEDULE_MAX_AHEAD_MS).toISOString())}
          onChange={(e) => setLocal(e.target.value)}
          className={field}
        />
      </label>
      <Actions busy={busy} error={error} confirmLabel={props.confirmLabel} onCancel={props.onCancel} onConfirm={() => void confirm()} />
    </Modal>
  );
}

/** One scheduled message: when, what, who; Editar / Cancelar for the author or an admin while pending (spec §3.2). */
export function ScheduledItem({ item, page = false }: { item: ScheduledMessageDto; page?: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.scheduled }); // the strip and every page tab

  async function cancel() {
    if (!(await confirmDialog({ title: 'Cancelar a mensagem agendada?', confirmLabel: 'Cancelar agendamento' }))) return;
    setError(null);
    try {
      await api.scheduled.cancel(item.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <li className="flex items-start gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted">
          <span className="font-semibold text-fg tabular-nums">{formatOfficeDateTime(item.sendAt)}</span>
          {page && (
            <>
              {' · '}
              <Link to={`/chats/${item.sentChatId ?? item.chatId}`} className="text-link hover:underline">
                {contactLabel(item.contact)}
              </Link>
            </>
          )}
          {` · por ${item.authorName}`}
          {page && (
            <>
              {' · '}
              <span>{STATUS_LABELS[item.status]}</span>
            </>
          )}
        </p>
        <p className="line-clamp-2 break-words whitespace-pre-wrap text-fg">{item.body}</p>
        {item.attachment && (
          <p className="flex items-center gap-1 text-xs text-muted">
            <Paperclip size={12} aria-hidden /> Anexo
          </p>
        )}
        {item.error && <p className="text-xs text-danger">{item.error}</p>}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      {item.canEdit && (
        <div className="flex shrink-0 gap-1">
          <button type="button" onClick={() => setEditing(true)} className="rounded px-2 py-1 text-xs font-medium text-link hover:bg-sidebar-hover">
            Editar
          </button>
          <button type="button" onClick={() => void cancel()} className="rounded px-2 py-1 text-xs font-medium text-danger hover:bg-sidebar-hover">
            Cancelar
          </button>
        </div>
      )}
      {editing && (
        <ScheduleDialog
          title="Editar agendamento"
          confirmLabel="Salvar"
          initialText={item.body}
          initialSendAt={item.sendAt}
          fileName={item.attachment?.name}
          onCancel={() => setEditing(false)}
          onConfirm={async (text, sendAt) => {
            await api.scheduled.update(item.id, sendAt ? { text, sendAt } : { text });
            setEditing(false);
            await refresh();
          }}
        />
      )}
    </li>
  );
}

/** Spec §3.2: "N mensagens agendadas" above the composer (or the closed footer); opens the list. */
export function ScheduledStrip({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: qk.chatScheduled(chatId), queryFn: () => api.scheduled.listForChat(chatId) });
  const items = list.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="border-t border-border bg-sunken px-6 pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-semibold text-link hover:underline"
      >
        <CalendarCheck size={14} aria-hidden />
        {scheduledCount(items.length)}
      </button>
      {open && (
        <ul className="max-h-48 divide-y divide-border overflow-y-auto">
          {items.map((i) => (
            <ScheduledItem key={i.id} item={i} />
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: The composer button**

In `web/src/components/conversation/Composer.tsx`, replace

```tsx
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Robot, Smiley, Sticker, Trash, X } from '@phosphor-icons/react';
```

with

```tsx
import {
  ArrowBendUpLeft, CalendarPlus, Lightning, Microphone, Paperclip, PaperPlaneRight, Robot, Smiley, Sticker, Trash, X,
} from '@phosphor-icons/react';
```

After `import { QuickAnswerPicker, filterQuickAnswers } from './QuickAnswerPicker';`, add:

```tsx
import { ScheduleDialog } from './Scheduled';
```

Replace

```tsx
  const [stickerOpen, setStickerOpen] = useState(false);
```

with

```tsx
  const [stickerOpen, setStickerOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
```

Before `async function toggleRecording() {`, add:

```tsx
  /** Spec 2026-10-20 agendamentos §3.1: the composer's text (and file, and signature choice) go out later. */
  function openSchedule() {
    if (!text.trim()) {
      setError('Digite a mensagem que será agendada');
      return;
    }
    setError(null);
    setScheduling(true);
  }

  async function schedule(value: string, sendAt: string) {
    await api.scheduled.create(chatId, { text: value, sendAt, signature, file: file ?? undefined });
    setScheduling(false);
    setText('');
    setFile(null);
    void qc.invalidateQueries({ queryKey: qk.chatScheduled(chatId), exact: true });
  }
```

Replace

```tsx
              <div className="ml-auto">
                {!isNote && !canSend ? (
```

with

```tsx
              <div className="ml-auto flex items-center gap-1">
                {!isNote && (
                  <ToolButton label="Agendar mensagem" onClick={openSchedule}>
                    <CalendarPlus size={20} />
                  </ToolButton>
                )}
                {!isNote && !canSend ? (
```

and replace

```tsx
        {botAsk && (
          <BotRunningDialog
```

with

```tsx
        {scheduling && (
          <ScheduleDialog
            title="Agendar mensagem"
            confirmLabel="Agendar"
            initialText={text.trim()}
            fileName={file?.name}
            onCancel={() => setScheduling(false)}
            /* a new schedule has no kept time, so sendAt is always set */
            onConfirm={(value, sendAt) => schedule(value, sendAt!)}
          />
        )}

        {botAsk && (
          <BotRunningDialog
```

- [ ] **Step 5: The strip in the conversation**

In `web/src/components/conversation/ConversationView.tsx`, after `import { ConversationHeader } from './ConversationHeader';`, add:

```tsx
import { ScheduledStrip } from './Scheduled';
```

Replace

```tsx
    void qc.invalidateQueries({ queryKey: qk.chatFavorites(chatId), exact: true });
  });
```

with

```tsx
    void qc.invalidateQueries({ queryKey: qk.chatFavorites(chatId), exact: true });
    // scheduling, editing, cancelling and each send or failure publish chat.updated (spec 2026-10-20 agendamentos §3.2)
    void qc.invalidateQueries({ queryKey: qk.chatScheduled(chatId), exact: true });
  });
```

and replace

```tsx
      <Timeline chatId={chatId} onReply={setReplyTo} chatOpen={chat.state === 'open'} focus={focus} />
```

with

```tsx
      <Timeline chatId={chatId} onReply={setReplyTo} chatOpen={chat.state === 'open'} focus={focus} />
      <ScheduledStrip chatId={chatId} />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/conversation`
Expected: PASS, including the existing composer tests: send, notes, quick answers, stickers and audio.

Run: `npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/conversation/Scheduled.tsx web/src/components/conversation/Scheduled.test.tsx web/src/components/conversation/Composer.tsx web/src/components/conversation/Composer.test.tsx web/src/components/conversation/ConversationView.tsx
git commit -m "feat(web): schedule a message from the composer and see the chat's pending ones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The "Agendamentos" page

**Files:**
- Create: `web/src/pages/ScheduledMessages.tsx`
- Modify: `web/src/App.tsx` (import, route)
- Modify: `web/src/components/layout/AppLayout.tsx` (icon import, menu item)
- Test: `web/src/pages/ScheduledMessages.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 `SCHEDULED_TABS`; Task 6 `api.scheduled.list`, `qk.scheduledList`; Task 7 `ScheduledItem`.
- Produces: `ScheduledMessagesPage` at `/agendamentos` (`?status=pending|sent|failed|canceled`, which the Task 6 toast links to).

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/ScheduledMessages.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ScheduledMessageDto } from '@talk/shared';
import { ScheduledMessagesPage } from './ScheduledMessages';

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const item = (over: Partial<ScheduledMessageDto> = {}): ScheduledMessageDto => ({
  id: 's1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
  body: 'Lembrete: audiência amanhã às 9h', signature: false, attachment: null, sendAt: '2026-10-21T12:00:00.000Z', status: 'pending',
  error: null, messageId: null, sentChatId: null, createdAt: '2026-10-20T12:00:00.000Z', finishedAt: null, canEdit: true, ...over,
});

function renderPage(entry = '/agendamentos') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/agendamentos" element={<ScheduledMessagesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens the tab named in the URL and shows why a message failed, linking to its chat (spec 2026-10-20 agendamentos §3.2)', async () => {
  stubFetch({
    'GET /api/scheduled-messages?status=failed': [
      item({ status: 'failed', error: 'Não enviada: o autor do agendamento está desativado', canEdit: false }),
    ],
  });
  renderPage('/agendamentos?status=failed');
  expect(await screen.findByText('Não enviada: o autor do agendamento está desativado')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Falharam' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('link', { name: 'Maria Cliente' }).getAttribute('href')).toBe('/chats/c1');
  expect(screen.getByText('Falhou')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
});

it('defaults to Pendentes, links a sent message to the chat it went to, and switches tab', async () => {
  stubFetch({
    'GET /api/scheduled-messages?status=pending': [item()],
    'GET /api/scheduled-messages?status=sent': [item({ id: 's2', status: 'sent', sentChatId: 'c9', canEdit: false })],
    'GET /api/scheduled-messages?status=canceled': [],
  });
  renderPage();
  expect(await screen.findByText('Lembrete: audiência amanhã às 9h')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Pendentes' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: 'Editar' })).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', { name: 'Enviadas' }));
  expect(await screen.findByText('Enviada')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Maria Cliente' }).getAttribute('href')).toBe('/chats/c9');

  fireEvent.click(screen.getByRole('tab', { name: 'Canceladas' }));
  expect(await screen.findByText('Nenhuma mensagem aqui.')).toBeTruthy();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w web -- src/pages/ScheduledMessages.test.tsx`
Expected: FAIL. `./ScheduledMessages` does not exist.

- [ ] **Step 3: Write the page**

Create `web/src/pages/ScheduledMessages.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { SCHEDULED_TABS, type ScheduledTab } from '@talk/shared';
import { ScheduledItem } from '../components/conversation/Scheduled';
import { api, qk } from '../lib/api';

const TAB_LABELS: Record<ScheduledTab, string> = { pending: 'Pendentes', sent: 'Enviadas', failed: 'Falharam', canceled: 'Canceladas' };
const isTab = (v: string | null): v is ScheduledTab => (SCHEDULED_TABS as readonly string[]).includes(v ?? '');

/** Spec 2026-10-20 agendamentos §3.2: an agent's own scheduled messages (an admin's: everyone's), one tab per status. */
export function ScheduledMessagesPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const tab: ScheduledTab = isTab(raw) ? raw : 'pending';
  // ponytail: polls every 30 s instead of a WS event of its own; the page's own changes refresh it at once
  const list = useQuery({ queryKey: qk.scheduledList(tab), queryFn: () => api.scheduled.list(tab), refetchInterval: 30_000 });

  return (
    <div className="h-full overflow-y-auto px-10 py-8">
      <section className="max-w-3xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Agendamentos</h1>
        <div role="tablist" aria-label="Situação" className="mb-4 flex flex-wrap gap-1">
          {SCHEDULED_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              onClick={() => setParams({ status: t })}
              className={`h-8 rounded-lg px-3 text-sm font-medium ${t === tab ? 'bg-primary-soft text-link' : 'text-muted hover:bg-sidebar-hover'}`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
        {list.isError && (
          <p role="alert" className="text-sm text-danger">
            Não foi possível carregar os agendamentos.
          </p>
        )}
        {list.data?.length === 0 && <p className="text-sm text-muted">Nenhuma mensagem aqui.</p>}
        {!!list.data?.length && (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface px-4">
            {list.data.map((i) => (
              <ScheduledItem key={i.id} item={i} page />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Route and menu**

In `web/src/App.tsx`, after `import Login from './pages/Login';`, add:

```tsx
import { ScheduledMessagesPage } from './pages/ScheduledMessages';
```

and replace

```tsx
      { path: 'contacts/new', element: <ContactNewPage /> },
```

with

```tsx
      { path: 'contacts/new', element: <ContactNewPage /> },
      { path: 'agendamentos', element: <ScheduledMessagesPage /> },
```

In `web/src/components/layout/AppLayout.tsx`, replace

```tsx
  AddressBookIcon,
  ChatCircleDotsIcon,
```

with

```tsx
  AddressBookIcon,
  CalendarCheckIcon,
  ChatCircleDotsIcon,
```

and replace

```tsx
        <NavItem to="/contacts" label="Contatos" icon={AddressBookIcon} />
```

with

```tsx
        <NavItem to="/contacts" label="Contatos" icon={AddressBookIcon} />
        <NavItem to="/agendamentos" label="Agendamentos" icon={CalendarCheckIcon} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w web -- src/pages/ScheduledMessages.test.tsx`
Expected: PASS.

Run: `npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/ScheduledMessages.tsx web/src/pages/ScheduledMessages.test.tsx web/src/App.tsx web/src/components/layout/AppLayout.tsx
git commit -m "feat(web): Agendamentos page with pendentes, enviadas, falharam and canceladas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: "Regras automáticas" settings page

**Files:**
- Create: `web/src/pages/settings/AutoRulesSettings.tsx`
- Modify: `web/src/pages/settings/SettingsPage.tsx` (import, section)
- Test: `web/src/pages/settings/AutoRulesSettings.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 `RETURN_TO_QUEUE_MINUTES`, `CLOSE_INACTIVE_HOURS`, `AutoRulesDto`; Task 6 `api.settings.autoRules`, `qk.autoRules`; `Section`, `field`, `btnPrimary`, `useSend`, `Loading`, `ErrorText`.
- Produces: `AutoRulesSettings` at `/configuracoes/regras` (admin only).

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/settings/AutoRulesSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_AUTO_RULES } from '@talk/shared';
import { AutoRulesSettings } from './AutoRulesSettings';

const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/settings/auto-rules' && method === 'GET') return json(DEFAULT_AUTO_RULES);
    if (path === '/api/settings/auto-rules' && method === 'PUT') return json(body);
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads both rules off and saves both with their values (spec 2026-10-20 agendamentos §4)', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AutoRulesSettings />
    </QueryClientProvider>,
  );

  const back = (await screen.findByLabelText('Devolver à fila conversas paradas')) as HTMLInputElement;
  const close = screen.getByLabelText('Finalizar por inatividade') as HTMLInputElement;
  const minutes = screen.getByLabelText('Minutos sem resposta') as HTMLInputElement;
  const hours = screen.getByLabelText('Horas sem mensagens') as HTMLInputElement;
  const closing = screen.getByLabelText('Enviar a mensagem de encerramento') as HTMLInputElement;
  expect([back.checked, close.checked, minutes.value, hours.value, closing.checked]).toEqual([false, false, '30', '24', true]);
  expect([minutes.min, minutes.max, hours.min, hours.max]).toEqual(['5', '1440', '1', '720']);

  fireEvent.click(back);
  fireEvent.change(minutes, { target: { value: '45' } });
  fireEvent.click(close);
  fireEvent.change(hours, { target: { value: '48' } });
  fireEvent.click(closing);
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Regras salvas.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    returnToQueue: { enabled: true, minutes: 45 },
    closeInactive: { enabled: true, hours: 48, sendClosingMessage: false },
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w web -- src/pages/settings/AutoRulesSettings.test.tsx`
Expected: FAIL. `./AutoRulesSettings` does not exist.

- [ ] **Step 3: Write the page and add it to Configurações**

Create `web/src/pages/settings/AutoRulesSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CLOSE_INACTIVE_HOURS, RETURN_TO_QUEUE_MINUTES, type AutoRulesDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btnPrimary, field, useSend } from '../../components/settings/common';

export function AutoRulesSettings() {
  const rules = useQuery({ queryKey: qk.autoRules, queryFn: api.settings.autoRules.get });
  if (!rules.data) return <Loading error={rules.error} />;
  return <AutoRulesForm rules={rules.data} />;
}

/** Spec 2026-10-20 agendamentos §4: both rules, off until an admin turns them on; the server checks the limits too. */
function AutoRulesForm({ rules }: { rules: AutoRulesDto }) {
  const [form, setForm] = useState(rules);
  const save = useSend(qk.autoRules);
  const setReturn = (patch: Partial<AutoRulesDto['returnToQueue']>) =>
    setForm((f) => ({ ...f, returnToQueue: { ...f.returnToQueue, ...patch } }));
  const setClose = (patch: Partial<AutoRulesDto['closeInactive']>) =>
    setForm((f) => ({ ...f, closeInactive: { ...f.closeInactive, ...patch } }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => api.settings.autoRules.put(form));
  }

  return (
    <Section title="Regras automáticas">
      <form onSubmit={submit} className="space-y-6">
        <fieldset className="space-y-2 rounded-lg border border-border p-4">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={form.returnToQueue.enabled} onChange={(e) => setReturn({ enabled: e.target.checked })} />
            Devolver à fila conversas paradas
          </label>
          <p className="text-xs text-muted">
            Quando o contato espera resposta há mais tempo que o limite, a conversa perde o atendente e volta para “Sem atendente” no
            mesmo setor. Quem assume a conversa ganha o prazo inteiro. Não vale para conversas privadas, em triagem ou com chatbot em
            execução.
          </p>
          <label className="block text-sm font-medium">
            Minutos sem resposta
            <input
              type="number"
              required
              step={1}
              min={RETURN_TO_QUEUE_MINUTES.min}
              max={RETURN_TO_QUEUE_MINUTES.max}
              value={form.returnToQueue.minutes}
              onChange={(e) => setReturn({ minutes: Number(e.target.value) })}
              className={field}
            />
          </label>
        </fieldset>

        <fieldset className="space-y-2 rounded-lg border border-border p-4">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={form.closeInactive.enabled} onChange={(e) => setClose({ enabled: e.target.checked })} />
            Finalizar por inatividade
          </label>
          <p className="text-xs text-muted">
            Quando o escritório falou por último e ninguém escreveu dentro do limite, a conversa é finalizada. Não vale para conversas
            em triagem, com chatbot em execução ou com mensagem agendada pendente.
          </p>
          <label className="block text-sm font-medium">
            Horas sem mensagens
            <input
              type="number"
              required
              step={1}
              min={CLOSE_INACTIVE_HOURS.min}
              max={CLOSE_INACTIVE_HOURS.max}
              value={form.closeInactive.hours}
              onChange={(e) => setClose({ hours: Number(e.target.value) })}
              className={field}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.closeInactive.sendClosingMessage}
              onChange={(e) => setClose({ sendClosingMessage: e.target.checked })}
            />
            Enviar a mensagem de encerramento
          </label>
          <p className="text-xs text-muted">Usa a mensagem de Configurações → Conversas.</p>
        </fieldset>

        <ErrorText error={save.error} />
        {save.isSuccess && <p className="text-sm text-success">Regras salvas.</p>}
        <button type="submit" disabled={save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
```

In `web/src/pages/settings/SettingsPage.tsx`, after `import { ChatSettings } from './ChatSettings';`, add:

```tsx
import { AutoRulesSettings } from './AutoRulesSettings';
```

and replace

```tsx
  { path: 'conversas', label: 'Conversas', group: 'Atendimento', adminOnly: true, page: ChatSettings },
```

with

```tsx
  { path: 'conversas', label: 'Conversas', group: 'Atendimento', adminOnly: true, page: ChatSettings },
  { path: 'regras', label: 'Regras automáticas', group: 'Atendimento', adminOnly: true, page: AutoRulesSettings },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/pages/settings`
Expected: PASS.

Run: `npm test` (all workspaces) and `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/settings/AutoRulesSettings.tsx web/src/pages/settings/AutoRulesSettings.test.tsx web/src/pages/settings/SettingsPage.tsx
git commit -m "feat(web): Regras automáticas settings page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review checklist (for the executor, after Task 9)

- [ ] Spec §3.1:
  - 2 min / 1 year on both sides, from the same `scheduleTimeProblem` (Tasks 1, 2, 7);
  - required text, at most 4096 characters;
  - the file saved at schedule time (Task 2), and its signature applied at send time (Task 3);
  - open chats only;
  - the timeline event.
- [ ] Spec §3.2:
  - the strip in open and closed chats (Task 7);
  - Editar/Cancelar for the author or an admin only (`canEdit`); 404 for anyone else; 409 once not pending;
  - "alterada" and "cancelada" events;
  - page tabs, admin sees all, 100 rows, 30 s refresh (Task 8).
- [ ] Spec §3.3:
  - SKIP LOCKED claim and the `status = 'sending'` guard;
  - `startChat` as the destination;
  - `botAction: 'keep'`;
  - late > 1 h, stuck > 10 min, deactivated author, gateway refusal with the message id;
  - `notifyUser` to the author only;
  - the "Agendada" mark;
  - the LID merge.
- [ ] Spec §4:
  - settings on their own route, both off by default (Task 4);
  - rule 1 counts from the newest of `waiting_since` and the owner events, once per wait;
  - rule 2 exclusions (waiting, bot, triage, history, pending schedule) and private chats included;
  - closing message as a system message, failure kept open;
  - beats of 15 s and 60 s (Task 5).
- [ ] Delivery 2 survives:
  - `waitingSince` writes in `send.ts` and `chats.ts`;
  - `setChatTags` and `validateTransferTarget`;
  - the `chat_tags` move in `absorb`;
  - the bulk and tags routes;
  - the `2026-10-20 delivery` block in `api.test.ts`.
- [ ] `ls server/drizzle/*.sql | tail -2` shows `0007_lista_dia_a_dia.sql` then `0008_agendamentos_e_regras.sql`, and `git diff feat/lista-dia-a-dia...HEAD -- server/drizzle/0007_lista_dia_a_dia.sql server/drizzle/meta/0007_snapshot.json` prints nothing.
- [ ] `grep -rn "console\." server/src/automation` shows only ids, counts and `errorTag(err)`.
- [ ] `grep -rn "storedFile\|scheduled:" server/src/chats/routes.ts` prints nothing (only the worker sets them).
