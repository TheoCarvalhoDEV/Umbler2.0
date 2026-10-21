# Appointments ("Compromissos") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent registers an appointment once: client, title, date and time in Cuiabá time, an internal note, 1 to 5 reminders and "Enviar com minha assinatura". This happens in the chat (a "Compromissos" button in the header) or in the Agenda's new "Compromissos" tab. Each reminder goes out as an ordinary scheduled message. Moving the appointment recalculates the reminders that have not gone out, in place. Cancelling it cancels them. Admins keep the default reminder texts in Configurações → Compromissos.

**Architecture:** Shared first. `shared/src/automation.ts` gains the appointment limits, the default reminders and five pure rules that the web and the server both run:
- `appointmentTimeProblem`;
- `reminderSendAt`: days go through `isoToOfficeLocal` → date − N → `officeLocalToIso`, so the Cuiabá wall time holds with no DST guess; hours are exact;
- `reminderTextProblem`;
- `remindersProblem`;
- `fillReminderText`.

Migration `0009` adds `appointments`, `appointment_reminders` and `scheduled_messages.reminder_id` (unique, `set null`). The link lives on the scheduled row. So the three places that ask "is this a reminder?" (the Agenda guard, `canEdit`, the inactivity rule) each test one column.

`server/src/automation/appointments.ts` is the service:
- **Create.** One transaction saves the appointment and its reminders. For each reminder whose send time passes `scheduleTimeProblem`, it adds one `scheduled_messages` row with the placeholders filled. The other reminders stay "Não criado": a reminder with no row.
- **Edit.** It locks the appointment (`FOR UPDATE`) and recalculates in place. A pending row is updated or deleted, always with `WHERE status = 'pending'`. A missing row is inserted once its time fits. A row the worker took is left alone.
- **Cancel.** It moves the pending rows to `canceled`.

`delivery.ts` is not touched: a reminder goes out exactly like any scheduled message.

Around it:
- the Agenda answers 409 for a reminder, and its DTO carries `appointment`;
- "Finalizar por inatividade" ignores reminders;
- the LID merge moves appointments with their chat;
- the default texts live in the `appointment_reminders` setting, behind their own GET (everyone) and PUT (admin).

The web adds:
- `api.appointments`;
- one `ReminderRows` editor, shared by the form and the settings page;
- the appointment form;
- the header button and the "Compromissos de <cliente>" dialog;
- the "Lembrete · <título>" mark;
- the Agenda's "Mensagens" / "Compromissos" tabs;
- the settings page.

**Tech Stack:** Node 24, TypeScript 5.9.3 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite 0.5.10 in tests), zod 4.6.7, vitest 5.0.4, React 19.3.1, @tanstack/react-query 5.104.2, react-router 8.4.0, Tailwind 4.3.3, @phosphor-icons/react 2.1.10. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-10-21-compromissos-design.md`.

**Base code.** This plan runs in the worktree `C:/Users/assis/Desktop/umbler-talk-compromissos`, on branch `feat/compromissos` at `af9b84e`. That base already holds:
- delivery 3: scheduled messages, automatic rules, migration `0008`;
- the Ajustes redesign (`feat/ajustes-mensageiro`).

Every "replace X with Y" snippet below quotes that code verbatim.

The worktree has no `node_modules`. Run `npm ci` once at its root before Task 1. It installs the lockfile as it is, so no dependency changes.

Never switch branches, push or merge. Never start or stop the dev server, its database or Evolution. Never run SQL by hand.

The following must survive:
- `server/src/automation/delivery.ts`, unchanged byte for byte;
- the scheduled-message API for plain rows, and the rules' existing exclusions;
- the Ajustes building blocks in `web/src/components/settings/common.tsx` (`PageHeader`, `SettingsSection`, `SettingRow`, `Switch`, `ListRow`, `RowMenu`, `EmptyState`, `SaveBar`);
- the `ui.ts` recipes;
- the "Agenda" menu label;
- `?status=` on the Agenda, which the failure toast opens.

**Decisions this plan takes beyond the spec** (each named where it is implemented):

1. §3.7 says the mark links to `/compromissos`. That path predates the tab decision, so it links to `/agendamentos?aba=compromissos`, as "Ver todos os compromissos" does.
2. The Compromissos tab keeps its own filter in `?situacao=upcoming|past|canceled`. Switching the top tabs only sets or removes `aba` and keeps `status` and `situacao`.
3. `POST /api/appointments` takes `signature` (default `true`). §5.3 leaves it out of the body, but §3.1 and §5.1 require it.
4. `canEdit`, `PATCH` and `cancel` also need `canSee` of the appointment's chat (§2). So an admin without "Ver todos os setores" edits only the appointments in chats he sees. The lists still show "mine" or "everyone's" exactly as §3.5 says.
5. A recalculation keeps a pending row whose send time did not change. A title change a minute before the send updates the text instead of deleting the reminder.
6. `reminderTextProblem(text, contactName?)` takes the contact name as an optional second argument, for the `{nome}` rule. The list rules (none, empty text, unknown placeholder, `{nome}`, same send time) live in one more shared function, `remindersProblem`, which the form, the settings page and both server routes call. In Configurações (no date) "same time" compares lead times: days × 24 against hours.
7. Two cases have no spec text and are kept simple:
   - The 4096 limit is checked on the raw text, not again after filling.
   - A recalculation whose contact lost its name, with a `{nome}` reminder, is refused (400) instead of sending "Olá, !".
8. `ReminderInput` and `AppointmentRemindersDto` live in `automation.ts` next to `DEFAULT_APPOINTMENT_REMINDERS`, which needs them, and are re-exported by `@talk/shared`.
9. Configurações → Compromissos uses `SaveBar`, like Regras automáticas. "Salvar" shows once something changed. `SaveBar` gains `savedText`, for "Lembretes salvos.". The preview there uses a fixed example: Maria, Audiência, 10/11/2026 14:00.
10. The lead amount is a `<select>` of the allowed numbers (1–30 days, 1–48 hours). It can never hold an out-of-range value.
11. Modal details:
    - `Modal` stops the Esc event from reaching an outer `Modal`, because forms open on top of the chat's appointments dialog.
    - That dialog has a "Fechar" button (copy already used in "Versões anteriores").
12. Ordering: reminders are listed by send time, and "Cancelados" is ordered by `starts_at`, newest first.
13. Two texts stay as they are: the Agenda's `h1` ("Agendamentos") and the description of "Finalizar por inatividade". Neither is in §6.

## Global Constraints

- No new dependency in any workspace.
- Every chat read goes through `getChatForUser` or `visibleChatsWhere`, so a chat the user cannot see answers 404. `canSee` already covers private chats.
- An appointment can be edited or cancelled by its author or by an admin, in a chat they see. Anyone else gets a 404, which reveals nothing.
- Every new mutation is a non-GET `/api/*` route, so the global Origin check (`authPlugin`) covers it:
  - `POST /api/appointments`;
  - `PATCH /api/appointments/:id`;
  - `POST /api/appointments/:id/cancel`;
  - `PUT /api/settings/appointment-reminders`.

  Tests send `loginAs(...).headers`. One test per route family sends no Origin and expects 403.
- Logs never carry a title, a note, reminder text, a phone or a name. This plan adds no log line. Any line added later carries only ids, counts and `errorTag(err)`.
- The migration is generated, never hand-edited:
  - `npm run db:generate -w server -- --name compromissos` creates `0009_compromissos`, right after `0008_agendamentos_e_regras`;
  - never regenerate or edit `0000`–`0008`;
  - the running dev server (`tsx watch`) applies the new migration to its own database when it restarts.
- Extend, never rename:
  - the only new field on an existing DTO is `ScheduledMessageDto.appointment?`, which is optional and always filled by the server;
  - the new DTOs are new types.
- Inside `ctx.db.transaction(tx => …)` use only `tx`, because PGlite deadlocks otherwise. Publish to the hub after commit.
- "Now" is `ctx.botRuntime.now()` everywhere on the server: limits, the Próximos/Passados split, `canceled_at`, `finished_at`. In tests that is the fake clock `ctx.clock`, which starts at `2026-10-14T13:00:00Z` (09:00 in Cuiabá).
- Never send twice:
  - This plan writes `scheduled_messages` only in four ways: insert a row for a reminder that has none (the unique index forbids a second); and update, delete or cancel, each with `status = 'pending'` in the `WHERE`.
  - `delivery.ts` is not touched: `git diff af9b84e -- server/src/automation/delivery.ts` prints nothing.
- Time tests set `process.env.TZ = 'Asia/Tokyo'` on the first line of the file, before any import, like `server/test/automation/office-time.test.ts` and `Scheduled.test.tsx`.
- Limits:
  - title: 1–120 characters;
  - note: up to 2000 characters;
  - reminders: 1–5;
  - lead time: 1–30 days or 1–48 hours;
  - reminder text: 1–`SCHEDULE_TEXT_MAX` (4096) characters;
  - appointment time: after now and at most `SCHEDULE_MAX_AHEAD_MS` (365 days) ahead;
  - reminder send time: `scheduleTimeProblem` (at least 2 min ahead), else "Não criado";
  - lists: 100 rows.
- UI copy is pt-BR, exactly as spec §6:
  - header button "Compromissos";
  - chat dialog: "Compromissos de <cliente>", "Nenhum compromisso marcado com este cliente.", "Novo compromisso", "Ver todos os compromissos";
  - form titles: "Novo compromisso" / "Editar compromisso";
  - form fields:
    - "Cliente" (with the example "Nome ou telefone");
    - "Título" (with "Ex.: Audiência, Retorno de documento");
    - "Data e hora (horário de Cuiabá)";
    - "Observação interna (não é enviada ao cliente)";
    - "Lembretes";
    - "Enviar com minha assinatura";
  - reminder line: "dias antes" / "horas antes", "Texto do lembrete", "Remover", "Adicionar lembrete", "Marcadores: {nome}, {titulo}, {data}, {hora}", "Vai sair assim: …", "Não será enviado: o horário de envio já passou";
  - form buttons: "Salvar" / "Cancelar";
  - the errors listed in §6;
  - reminder situations: "Pendente · <dd/mm/aaaa hh:mm>", "Enviando…", "Enviado", "Falhou: <motivo>", "Cancelado", "Não criado: o horário de envio já tinha passado";
  - lead times: "2 dias antes", "1 dia antes", "1 hora antes", "3 horas antes";
  - item: "por <nome>", "Observação interna", "Editar", "Cancelar", the badge "Cancelado";
  - cancel confirmation: "Cancelar o compromisso?" / "Os lembretes que ainda não saíram não serão enviados." / "Cancelar compromisso" / "Manter compromisso";
  - mark: "Lembrete · <título>";
  - Agenda tabs: "Mensagens" / "Compromissos", then "Próximos" / "Passados" / "Cancelados", empty state "Nenhum compromisso aqui.";
  - events:
    - "Compromisso “<título>” marcado por <nome> para <data>";
    - "… remarcado por …";
    - "Compromisso “<título>” cancelado por <nome>";
  - settings: "Compromissos", "Lembretes que já vêm preenchidos em todo compromisso novo. Cada compromisso pode mudar os seus.", "Salvar", "Lembretes salvos.".
- Code identifiers are English.
- Theme tokens only, through the `web/src/components/ui.ts` recipes wherever one exists:
  - recipes: `button`, `field`, `fieldArea`, `fieldSelect`, `fieldLabel`, `fieldHint`, `fieldError`, `checkbox`, `tab` / `tabList`, `badge` / `badgeTone`, `menuItem`, `card`, `pageTitle`;
  - plain tokens: `text-warning`, `bg-sunken`, `text-muted`, `text-link`, `divide-border`.

  Never a raw color. Never a second width, height or color on a recipe: wrap the control in a sized `<div>`, as `AutoRulesSettings` does.
- Reuse what exists:
  - from the conversation components: `Modal` / `Actions` (`ChatDialogs.tsx`), `confirmDialog`, `errorMessage`, `contactLabel`;
  - from `components/settings/common.tsx`: `PageHeader`, `SettingsSection`, `SaveBar`, `Loading`, `useSend`;
  - on the server: `getChatForUser`, `visibleChatsWhere`, `canSee`, `addEvent`, `scheduleTimeProblem`, `isoToOfficeLocal` / `officeLocalToIso` / `formatOfficeDateTime`;
  - in tests: `seedChat`, `insertChat`, `newContact`, `eventsOf`, `insertScheduled`, `enableSeeAll`.
- Commit after every task with a Conventional Commit message, staging only that task's files. Every commit command ends with `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

## Review Focus

These are the inputs and conditions most likely to go wrong, most likely first. The owning task adds the named test.

1. **A reminder going out twice, or a moved one going out at its old time.** A reschedule races the 15 s worker. Every write to a reminder's row must re-check `status = 'pending'`. A row the worker took (`sending`, `sent`, `failed`) must never be updated or created again; there is one row per reminder, enforced by the unique index. **Owner:**
   - Task 3, tests `leaves sent, failed and sending rows alone and never creates them again (Review Focus 1)` and `a title change a minute before a reminder goes out keeps that reminder (Review Focus 1)`;
   - Task 4, test `a reschedule sends it once, at the new time (Review Focus 1)`.
2. **"N dias antes" in the wrong zone.** Computing it as N × 24 h, or in the host's zone instead of Cuiabá wall time, shifts every reminder when the host zone is not Cuiabá, or across a month or a year. **Owner:**
   - Task 1, test `"N dias antes" keeps the Cuiabá wall time, across a month and a year (Review Focus 2)`;
   - Task 7, test `starts with the default reminders, reads the time as Cuiabá time, warns live and previews the text (Review Focus 2)`.
3. **Appointments from chats the user cannot see.** Two paths look beyond one chat, and both must filter with `visibleChatsWhere`:
   - the chat dialog lists by contact, across the contact's chats;
   - the Agenda form gives only a `contactId`, and the server picks the chat.

   **Owner:** Task 2, tests `the chat lists the contact's upcoming appointments in every chat the user sees, next first (Review Focus 3)` and `by contactId: the open chat the user sees, else the newest one they see; none → 400; no such contact → 404 (Review Focus 3)`.
4. **The Agenda changing a reminder behind its appointment.** On a reminder row:
   - `PATCH` and `cancel` must answer 409, but only after the 404 for someone who may not manage it;
   - `canEdit` must be false.

   **Owner:** Task 4, test `a reminder carries its appointment, cannot be edited or cancelled there (409), and anyone else still gets 404 (Review Focus 4)`.
5. **The existing paths losing appointments or holding chats open:**
   - the LID merge deletes the absorbed chat, and the cascade would take its appointments with it;
   - deleting a chat reaches `scheduled_messages` by two cascade paths;
   - "Finalizar por inatividade" would keep a chat open 30 days for a reminder.

   **Owner:** Task 4, tests:
   - `an absorbed chat's appointments move to the twin, with their reminders (spec 2026-10-21 compromissos §3.8; Review Focus 5)`;
   - `deleting the chat removes its appointments, their reminders and their scheduled messages (spec 2026-10-21 compromissos §3.8; Review Focus 5)`;
   - `a pending appointment reminder does not keep the chat open (spec 2026-10-21 compromissos §3.6, decision 10; Review Focus 5)`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Shared**
- `shared/src/automation.ts` (T1): `REMINDER_UNITS`, `ReminderUnit`, `APPOINTMENT_LIMITS`, `REMINDER_PLACEHOLDERS`, `APPOINTMENT_TABS`, `AppointmentTab`, `ReminderInput`, `AppointmentRemindersDto`, `DEFAULT_APPOINTMENT_REMINDERS`, `appointmentTimeProblem`, `reminderSendAt`, `reminderTextProblem`, `remindersProblem`, `fillReminderText`.
- `shared/src/index.ts` (T1): re-exports, the two new `ChatEventKind`s, `ScheduledMessageDto.appointment?`, `AppointmentReminderDto`, `AppointmentDto`.

**Server**
- `server/src/db/schema.ts` (T1): tables `appointments`, `appointmentReminders`; `scheduledMessages.reminderId` and its unique index.
- `server/drizzle/0009_compromissos.sql`, `server/drizzle/meta/0009_snapshot.json`, `server/drizzle/meta/_journal.json` (T1): the generated migration.
- `server/src/catalog/settings.ts`:
  - T2: `reminderList`, the zod list shared with the create route;
  - T5: `getAppointmentReminders` and `GET` / `PUT /api/settings/appointment-reminders`.
- `server/src/automation/scheduled.ts`:
  - T2: `canManage` exported;
  - T4: `REMINDER_LOCKED`, the reminder guard and `ScheduledMessageDto.appointment`.
- `server/src/automation/appointments.ts`:
  - T2, create: `createAppointment`, `listChatAppointments`, `listAppointments`, `NO_CHAT_WITH_CONTACT`, `AppointmentInput`;
  - T3: `updateAppointment`, `cancelAppointment`, `APPOINTMENT_CANCELED`.
- `server/src/automation/routes.ts` (T2, T3): the five appointment routes.
- `server/src/automation/rules.ts` (T4): the inactivity rule ignores reminders.
- `server/src/history/merge.ts` (T4): `absorb` moves appointments.

**Server tests**
- `server/test/db/schema.test.ts` (T1).
- `server/test/automation/appointment-rules.test.ts` (T1, create).
- `server/test/automation/seed.ts` (T2): `insertAppointment`.
- `server/test/automation/appointments-api.test.ts` (T2, create).
- `server/test/automation/appointments-edit.test.ts` (T3, create).
- `server/test/automation/scheduled-api.test.ts`, `rules.test.ts`, `delivery.test.ts`, `server/test/history/merge.test.ts`, `server/test/chats/delete-and-unread.test.ts` (T4).
- `server/test/catalog/settings.test.ts` (T5).

**Web**
- `web/src/components/conversation/model.ts` (+ `model.test.ts`) (T1): `eventText` for the two new events.
- `web/src/lib/api.ts` (+ `api.test.ts`) (T6):
  - types `AppointmentInput`, `AppointmentPatch`;
  - calls `api.appointments.*`, `api.settings.appointmentReminders.*`;
  - query keys `qk.appointments`, `qk.chatAppointments`, `qk.appointmentList`, `qk.appointmentReminders`.
- `web/src/components/conversation/Scheduled.tsx` (+ `Scheduled.test.tsx`) (T6): the "Lembrete · <título>" mark.
- `web/src/components/conversation/Appointments.tsx` (+ `Appointments.test.tsx`) (T7, create): `reminderLead`, `reminderStatus`, `ReminderSample`, `ReminderRows`, `AppointmentDialog`, `AppointmentItem`, `ChatAppointmentsDialog`.
- `web/src/components/conversation/ChatDialogs.tsx` (T7): `Modal`'s Esc stops at the top dialog.
- `web/src/components/conversation/ConversationHeader.tsx` (+ `ConversationHeader.test.tsx`) (T7): the "Compromissos" button.
- `web/src/components/conversation/ConversationView.tsx` (T7): refreshes the chat's appointments on `chat.updated`.
- `web/src/pages/ScheduledMessages.tsx` (+ `ScheduledMessages.test.tsx`) (T8): the "Mensagens" / "Compromissos" tabs.
- `web/src/components/settings/common.tsx` (T9): `SaveBar.savedText`.
- `web/src/pages/settings/AppointmentSettings.tsx` (+ `AppointmentSettings.test.tsx`) (T9, create).
- `web/src/pages/settings/SettingsPage.tsx` (+ `SettingsPage.test.tsx`) (T9).

**Docs**
- `docs/superpowers/plans/2026-10-21-compromissos-aceite.md` (T10, create): the manual acceptance script of spec §8.

---

## Shared contract

Every name below is defined in exactly one task and used with this spelling everywhere.

**`shared/src/automation.ts` (Task 1)**
```ts
export const REMINDER_UNITS: readonly ['days', 'hours'];
export type ReminderUnit = (typeof REMINDER_UNITS)[number];
export const APPOINTMENT_LIMITS: { titleMax: 120; noteMax: 2000; remindersMax: 5; days: { min: 1; max: 30 }; hours: { min: 1; max: 48 } };
export const REMINDER_PLACEHOLDERS: readonly ['nome', 'titulo', 'data', 'hora'];
export const APPOINTMENT_TABS: readonly ['upcoming', 'past', 'canceled'];
export type AppointmentTab = (typeof APPOINTMENT_TABS)[number];
export interface ReminderInput { amount: number; unit: ReminderUnit; text: string }
export interface AppointmentRemindersDto { reminders: ReminderInput[] }
export const DEFAULT_APPOINTMENT_REMINDERS: AppointmentRemindersDto; // "2 dias antes" + "1 hora antes", spec §4
export function appointmentTimeProblem(startsAt: Date | null, now: Date): string | null;
export function reminderSendAt(startsAt: Date, amount: number, unit: ReminderUnit): Date;
/** contactName: null/blank = the contact has no name ({nome} refused); undefined = no contact (Configurações). */
export function reminderTextProblem(text: string, contactName?: string | null): string | null;
/** startsAt null (Configurações): "same time" compares lead times. */
export function remindersProblem(reminders: ReminderInput[], startsAt: Date | null, contactName?: string | null): string | null;
export function fillReminderText(text: string, v: { nome: string; titulo: string; startsAt: string }): string;
```

**`shared/src/index.ts` (Task 1)**
```ts
// ChatEventKind gains: 'appointment_scheduled' (data { appointmentId, title, startsAt, edited? })
//                    | 'appointment_canceled'  (data { appointmentId, title }); the note never goes into an event
// ScheduledMessageDto gains (optional): appointment?: { id: string; title: string } | null
export interface AppointmentReminderDto { id: string; amount: number; unit: ReminderUnit; text: string; sendAt: string;
  status: ScheduledStatus | 'skipped'; scheduledId: string | null; error: string | null }
export interface AppointmentDto { id: string; chatId: string; contact: { id: string; name: string | null; phone: string | null };
  authorId: string; authorName: string; title: string; startsAt: string; note: string | null; canceledAt: string | null;
  canceledByName: string | null; createdAt: string; reminders: AppointmentReminderDto[]; canEdit: boolean }
```

**`server/src/db/schema.ts` (Task 1)**
- `appointments`:
  - `id`;
  - `chatId` → chats, cascade;
  - `authorId` → users;
  - `title`, `startsAt`, `note` (null = none), `signature` (default true), `createdAt`;
  - `canceledAt`;
  - `canceledBy` → users, set null;
  - indexes `appointments_starts_at_idx` and `appointments_chat_idx`.
- `appointmentReminders`:
  - `id`;
  - `appointmentId` → appointments, cascade;
  - `amount`, `unit` (`ReminderUnit`), `text` (placeholders kept), `createdAt`;
  - index `appointment_reminders_appointment_idx`.
- `scheduledMessages.reminderId` → appointment_reminders, set null; unique index `scheduled_messages_reminder_unique`.

**Server**
```ts
// server/src/catalog/settings.ts (Task 2; Task 5 adds the rest)
export const reminderList: z.ZodType<ReminderInput[]>; // 1–5 lines, unit limits, text 1–4096 after trim
export async function getAppointmentReminders(db: Db | Tx): Promise<AppointmentRemindersDto>; // Task 5
// server/src/automation/scheduled.ts
export const canManage: (user: AuthUser, row: { authorId: string }) => boolean; // Task 2 (exported)
export const REMINDER_LOCKED: string; // Task 4: 'Este lembrete é de um compromisso; altere pelo compromisso'
// server/src/automation/appointments.ts
export const NO_CHAT_WITH_CONTACT: string; // Task 2
export interface AppointmentInput { chatId?: string; contactId?: string; title: string; startsAt: Date; note: string | null; signature: boolean; reminders: ReminderInput[] }
export async function createAppointment(ctx: AppCtx, user: AuthUser, input: AppointmentInput): Promise<AppointmentDto>; // Task 2
export async function listChatAppointments(ctx: AppCtx, user: AuthUser, chatId: string): Promise<AppointmentDto[]>; // Task 2
export async function listAppointments(ctx: AppCtx, user: AuthUser, tab: AppointmentTab): Promise<AppointmentDto[]>; // Task 2
export const APPOINTMENT_CANCELED: string; // Task 3: 'Este compromisso foi cancelado'
export async function updateAppointment(ctx: AppCtx, user: AuthUser, id: string, patch: { title?: string; startsAt?: Date; note?: string | null }): Promise<AppointmentDto>; // Task 3
export async function cancelAppointment(ctx: AppCtx, user: AuthUser, id: string): Promise<AppointmentDto>; // Task 3
```

**HTTP**
| Route | Body / query | Answer | Task |
|---|---|---|---|
| `POST /api/appointments` | `{ chatId \| contactId (exactly one), title, startsAt, note?, signature?, reminders }` | `AppointmentDto` | 2 |
| `GET /api/chats/:id/appointments` | | `AppointmentDto[]`: the contact's upcoming, in chats the user sees, next first | 2 |
| `GET /api/appointments` | `tab` (`APPOINTMENT_TABS`, default `upcoming`) | `AppointmentDto[]`: mine (admin: all) | 2 |
| `PATCH /api/appointments/:id` | `{ title?, startsAt?, note? }` (at least one; `note: null` or `""` clears it) | `AppointmentDto` | 3 |
| `POST /api/appointments/:id/cancel` | | `AppointmentDto` | 3 |
| `GET /api/settings/appointment-reminders` | (any user) | `AppointmentRemindersDto` | 5 |
| `PUT /api/settings/appointment-reminders` | `AppointmentRemindersDto` (admin) | `AppointmentRemindersDto` | 5 |

`startsAt` is an ISO date-time with an offset (`z.iso.datetime({ offset: true })`, the existing `sendAt` schema). The answers:
- a zod error is 400 "Requisição inválida" (the app's error handler);
- a broken rule is 400 with the pt-BR text of §6.

**Web**
- `web/src/lib/api.ts` (Task 6):
  - types `AppointmentInput { chatId?; contactId?; title; startsAt; note?; signature; reminders }` and `AppointmentPatch { title?; startsAt?; note?: string | null }`;
  - calls `api.appointments.listForChat(chatId)`, `list(tab)`, `create(input)`, `update(id, patch)`, `cancel(id)`, and `api.settings.appointmentReminders.get()`, `put(value)`;
  - query keys:
    - `qk.appointments`, the prefix `['chats', 'appointments']`;
    - `qk.chatAppointments(chatId)`;
    - `qk.appointmentList(tab)`;
    - `qk.appointmentReminders`, `['settings', 'appointment-reminders']`.
- `web/src/components/conversation/Appointments.tsx` (Task 7):
  - `reminderLead(r)`, `reminderStatus(r)`, `interface ReminderSample { nome; titulo; startsAt }`;
  - `ReminderRows({ reminders, onChange, sample, contactName?, startsAt? })`;
  - `AppointmentDialog({ chatId?, contactName?, appointment?, onClose })`;
  - `AppointmentItem({ item, page? })`;
  - `ChatAppointmentsDialog({ chat, onClose })`.
- Agenda URL (Task 8): `/agendamentos?aba=compromissos&situacao=upcoming|past|canceled`. Without `aba` the page opens "Mensagens", which keeps `?status=`.
- `web/src/components/settings/common.tsx` (Task 9): `SaveBar` gains `savedText?: string`.
- `web/src/pages/settings/AppointmentSettings.tsx` (Task 9): `AppointmentSettings` at `/configuracoes/compromissos` (admin only).

---

### Task 1: Shared contract, the two tables, `scheduled_messages.reminder_id` and migration 0009

Nothing reads the new tables yet. This task has to compile, migrate, compute reminder times in Cuiabá wall time, and describe the two new events. The new `ChatEventKind`s force `eventText`'s exhaustive switch to change in this task too, or the web typecheck fails.

**Files:**
- Modify: `shared/src/automation.ts` (append)
- Modify: `shared/src/index.ts` (type import, re-exports, `ChatEventKind`, `ScheduledMessageDto`, new DTOs)
- Modify: `server/src/db/schema.ts` (`@talk/shared` import, two tables before `scheduledMessages`, its new column and index)
- Generated: `server/drizzle/0009_compromissos.sql`, `server/drizzle/meta/0009_snapshot.json`, `server/drizzle/meta/_journal.json`
- Modify: `web/src/components/conversation/model.ts` (`eventText`)
- Test: `server/test/automation/appointment-rules.test.ts` (create), `server/test/db/schema.test.ts`, `web/src/components/conversation/model.test.ts`

**Interfaces:**
- Consumes: `SCHEDULE_MAX_AHEAD_MS`, `isoToOfficeLocal`, `officeLocalToIso`, `formatOfficeDateTime` (already in `automation.ts`).
- Produces: everything under `shared/src/automation.ts`, `shared/src/index.ts` and `server/src/db/schema.ts` in the Shared contract.

- [ ] **Step 1: Write the failing tests**

Create `server/test/automation/appointment-rules.test.ts`:

```ts
// Review Focus 2: "N dias antes" must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPOINTMENT_REMINDERS, SCHEDULE_MAX_AHEAD_MS, appointmentTimeProblem, fillReminderText, reminderSendAt,
  reminderTextProblem, remindersProblem,
} from '@talk/shared';

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe('reminderSendAt (spec 2026-10-21 compromissos §3.2, decision 7)', () => {
  it('"N dias antes" keeps the Cuiabá wall time, across a month and a year (Review Focus 2)', () => {
    // 25/10/2026 14:00 Cuiabá − 2 days = 23/10/2026 14:00 Cuiabá (the spec's example)
    expect(iso(reminderSendAt(at('2026-10-25T18:00:00.000Z'), 2, 'days'))).toBe('2026-10-23T18:00:00.000Z');
    // month: 01/11/2026 08:30 − 1 day = 31/10/2026 08:30
    expect(iso(reminderSendAt(at('2026-11-01T12:30:00.000Z'), 1, 'days'))).toBe('2026-10-31T12:30:00.000Z');
    // year: 01/01/2027 10:00 − 2 days = 30/12/2026 10:00
    expect(iso(reminderSendAt(at('2027-01-01T14:00:00.000Z'), 2, 'days'))).toBe('2026-12-30T14:00:00.000Z');
    // the Cuiabá date, not the UTC one: 31/12/2026 23:30 Cuiabá is already 01/01 in UTC (and in Tokyo)
    expect(iso(reminderSendAt(at('2027-01-01T03:30:00.000Z'), 1, 'days'))).toBe('2026-12-31T03:30:00.000Z');
    // 30 days back across February (28 days in 2027): 02/03/2027 09:00 → 31/01/2027 09:00
    expect(iso(reminderSendAt(at('2027-03-02T13:00:00.000Z'), 30, 'days'))).toBe('2027-01-31T13:00:00.000Z');
  });

  it('"N horas antes" takes exactly N × 60 minutes', () => {
    expect(iso(reminderSendAt(at('2026-10-25T18:00:00.000Z'), 1, 'hours'))).toBe('2026-10-25T17:00:00.000Z');
    expect(iso(reminderSendAt(at('2026-10-25T18:00:00.000Z'), 48, 'hours'))).toBe('2026-10-23T18:00:00.000Z');
  });
});

describe('appointment rules shared by the web and the server (spec §3.1–3.2)', () => {
  it('appointmentTimeProblem: empty, now, the past and past 1 year', () => {
    const now = at('2026-10-20T12:00:00.000Z');
    expect(appointmentTimeProblem(null, now)).toBe('Escolha a data e a hora');
    expect(appointmentTimeProblem(at('nope'), now)).toBe('Escolha a data e a hora');
    expect(appointmentTimeProblem(now, now)).toBe('Este horário já passou; escolha uma data e hora futuras');
    expect(appointmentTimeProblem(at('2026-10-20T11:59:00.000Z'), now)).toBe('Este horário já passou; escolha uma data e hora futuras');
    expect(appointmentTimeProblem(at('2026-10-20T12:01:00.000Z'), now)).toBeNull();
    expect(appointmentTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS), now)).toBeNull();
    expect(appointmentTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS + 60_000), now)).toBe('Escolha um horário em até 1 ano');
  });

  it('fillReminderText: {data} and {hora} in Cuiabá time with the host in Tokyo, and nothing read as a pattern', () => {
    // 20/10/2026 13:30 in Cuiabá is already 21/10 02:30 in Tokyo
    const startsAt = '2026-10-20T17:30:00.000Z';
    expect(fillReminderText(DEFAULT_APPOINTMENT_REMINDERS.reminders[1]!.text, { nome: 'Maria', titulo: 'Audiência', startsAt })).toBe(
      'Olá, Maria! Seu compromisso (Audiência) é às 13:30 de 20/10/2026 (horário de Cuiabá).',
    );
    expect(fillReminderText('{nome} {nome} $& {titulo}', { nome: 'Ana', titulo: 'R$ 10', startsAt })).toBe('Ana Ana $& R$ 10');
  });

  it('reminderTextProblem and remindersProblem (decision 6)', () => {
    expect(reminderTextProblem('Olá, {nome}! {titulo} em {data} às {hora}', 'Maria')).toBeNull();
    expect(reminderTextProblem('Olá, {Nome}!')).toBe('Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}');
    expect(reminderTextProblem('Olá, {nome}!', null)).toBe('O contato não tem nome cadastrado; tire {nome} do lembrete');
    expect(reminderTextProblem('Olá, {nome}!', '  ')).toBe('O contato não tem nome cadastrado; tire {nome} do lembrete');
    expect(reminderTextProblem('Olá, {nome}!')).toBeNull(); // Configurações: no contact
    expect(reminderTextProblem('Olá!', null)).toBeNull();

    const startsAt = at('2026-10-25T18:00:00.000Z');
    const r = (amount: number, unit: 'days' | 'hours', text = 'Lembrete') => ({ amount, unit, text });
    expect(remindersProblem([], startsAt, 'Maria')).toBe('Inclua pelo menos um lembrete');
    expect(remindersProblem([r(1, 'days', '  ')], startsAt, 'Maria')).toBe('Digite o texto do lembrete');
    expect(remindersProblem([r(2, 'days'), r(48, 'hours')], startsAt, 'Maria')).toBe('Dois lembretes cairiam no mesmo horário');
    expect(remindersProblem([r(2, 'days'), r(48, 'hours')], null)).toBe('Dois lembretes cairiam no mesmo horário');
    expect(remindersProblem(DEFAULT_APPOINTMENT_REMINDERS.reminders, startsAt, 'Maria')).toBeNull();
    expect(remindersProblem(DEFAULT_APPOINTMENT_REMINDERS.reminders, startsAt, null)).toBe(
      'O contato não tem nome cadastrado; tire {nome} do lembrete',
    );
  });
});
```

In `server/test/db/schema.test.ts`, replace

```ts
import {
  botRuns, botVersions, bots, chatTags, chats, contacts, historyImports, messageEdits, messageFavorites, messages, scheduledMessages,
  sectors, tags,
} from '../../src/db/schema.js';
```

with

```ts
import {
  appointmentReminders, appointments, botRuns, botVersions, bots, chatTags, chats, contacts, historyImports, messageEdits,
  messageFavorites, messages, scheduledMessages, sectors, tags,
} from '../../src/db/schema.js';
```

Then replace `expect(tables).toHaveLength(26);` with `expect(tables).toHaveLength(28);`. Then replace

```ts
    await db.delete(chats).where(eq(chats.id, chat!.id));
    expect(await db.select().from(scheduledMessages)).toEqual([]);
  });
});

describe('bot tables', () => {
```

with

```ts
    await db.delete(chats).where(eq(chats.id, chat!.id));
    expect(await db.select().from(scheduledMessages)).toEqual([]);
  });

  it('appointments: one scheduled message per reminder at most, unlinked with the reminder, gone with the chat (spec 2026-10-21 compromissos §5.1)', async () => {
    const [c] = await db.insert(contacts).values({ phone: '5565999990005' }).returning({ id: contacts.id });
    const [chat] = await db
      .insert(chats)
      .values({ contactId: c!.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning({ id: chats.id });
    const [a] = await db
      .insert(appointments)
      .values({ chatId: chat!.id, authorId: s.agentA.id, title: 'Audiência', startsAt: new Date() })
      .returning();
    expect(a).toMatchObject({ note: null, signature: true, canceledAt: null, canceledBy: null });
    const [r] = await db
      .insert(appointmentReminders)
      .values({ appointmentId: a!.id, amount: 2, unit: 'days', text: 'Olá, {nome}!' })
      .returning();
    const row = { chatId: chat!.id, authorId: s.agentA.id, body: 'Olá, Maria!', signature: true, sendAt: new Date() };
    expect(await pgCode(db.insert(scheduledMessages).values({ ...row, reminderId: r!.id }))).toBeNull();
    expect(await pgCode(db.insert(scheduledMessages).values({ ...row, reminderId: r!.id }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(scheduledMessages).values([row, row]))).toBeNull(); // plain scheduled messages: no reminder

    await db.delete(appointmentReminders).where(eq(appointmentReminders.id, r!.id));
    expect((await db.select().from(scheduledMessages)).map((x) => x.reminderId)).toEqual([null, null, null]);
    await db.delete(chats).where(eq(chats.id, chat!.id));
    expect(await db.select().from(appointments)).toEqual([]);
    expect(await db.select().from(scheduledMessages)).toEqual([]);
  });
});

describe('bot tables', () => {
```

In `web/src/components/conversation/model.test.ts`, add after the `describe('eventText for scheduled messages and automatic rules (spec 2026-10-20 agendamentos)', …)` block:

```ts
describe('eventText for appointments (spec 2026-10-21 compromissos §6)', () => {
  it('says marcado, remarcado and cancelado, with the date in Cuiabá time', () => {
    const data = { appointmentId: 'a1', title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z' }; // 14:00 in Cuiabá
    expect(eventText(event({ kind: 'appointment_scheduled', authorName: 'Bia', data }), new Map())).toBe(
      'Compromisso “Audiência” marcado por Bia para 21/10/2026 14:00',
    );
    expect(eventText(event({ kind: 'appointment_scheduled', authorName: 'Bia', data: { ...data, edited: true } }), new Map())).toBe(
      'Compromisso “Audiência” remarcado por Bia para 21/10/2026 14:00',
    );
    expect(
      eventText(event({ kind: 'appointment_canceled', authorName: 'Bia', data: { appointmentId: 'a1', title: 'Audiência' } }), new Map()),
    ).toBe('Compromisso “Audiência” cancelado por Bia');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/automation/appointment-rules.test.ts test/db/schema.test.ts`
Expected: FAIL, for three reasons:
- the new functions are not exported by `@talk/shared` (`reminderSendAt is not a function`);
- `appointments` is not exported by `schema.js`;
- the table count is 26.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL on the new test, because `eventText` returns `undefined` for the new kinds.

- [ ] **Step 3: Add the shared rules**

In `shared/src/automation.ts`, replace

```ts
export const DEFAULT_AUTO_RULES: AutoRulesDto = {
  returnToQueue: { enabled: false, minutes: 30 },
  closeInactive: { enabled: false, hours: 24, sendClosingMessage: true },
};
```

with

```ts
export const DEFAULT_AUTO_RULES: AutoRulesDto = {
  returnToQueue: { enabled: false, minutes: 30 },
  closeInactive: { enabled: false, hours: 24, sendClosingMessage: true },
};

// ---------- Compromissos (spec 2026-10-21 compromissos §3–§5) ----------

/** A reminder goes N days (the same Cuiabá wall time) or N hours before the appointment. */
export const REMINDER_UNITS = ['days', 'hours'] as const;
export type ReminderUnit = (typeof REMINDER_UNITS)[number];
export const APPOINTMENT_LIMITS = {
  titleMax: 120, noteMax: 2000, remindersMax: 5, days: { min: 1, max: 30 }, hours: { min: 1, max: 48 },
} as const;
export const REMINDER_PLACEHOLDERS = ['nome', 'titulo', 'data', 'hora'] as const;
/** The Agenda's "Compromissos" tabs: Próximos, Passados, Cancelados. */
export const APPOINTMENT_TABS = ['upcoming', 'past', 'canceled'] as const;
export type AppointmentTab = (typeof APPOINTMENT_TABS)[number];
/** One reminder as typed: the text keeps its placeholders. */
export interface ReminderInput { amount: number; unit: ReminderUnit; text: string }
/** Configurações → Compromissos (settings key 'appointment_reminders'): what every new appointment starts with. */
export interface AppointmentRemindersDto { reminders: ReminderInput[] }
export const DEFAULT_APPOINTMENT_REMINDERS: AppointmentRemindersDto = {
  reminders: [
    {
      amount: 2,
      unit: 'days',
      text: 'Olá, {nome}! Lembramos do seu compromisso ({titulo}) no dia {data}, às {hora} (horário de Cuiabá). Qualquer dúvida, é só responder esta mensagem.',
    },
    { amount: 1, unit: 'hours', text: 'Olá, {nome}! Seu compromisso ({titulo}) é às {hora} de {data} (horário de Cuiabá).' },
  ],
};

/** The pt-BR reason an appointment time is refused, or null: after now, at most 1 year ahead (spec §3.1). Same check on both sides. */
export function appointmentTimeProblem(startsAt: Date | null, now: Date): string | null {
  if (!startsAt || Number.isNaN(startsAt.getTime())) return 'Escolha a data e a hora';
  if (startsAt.getTime() <= now.getTime()) return 'Este horário já passou; escolha uma data e hora futuras';
  if (startsAt.getTime() > now.getTime() + SCHEDULE_MAX_AHEAD_MS) return 'Escolha um horário em até 1 ano';
  return null;
}

/**
 * When a reminder goes out (spec §3.2, decision 7). "N horas antes" is exact. "N dias antes" keeps the Cuiabá wall time:
 * the office date minus N days, read back through officeLocalToIso, so no DST rule is assumed either way.
 */
export function reminderSendAt(startsAt: Date, amount: number, unit: ReminderUnit): Date {
  if (unit === 'hours') return new Date(startsAt.getTime() - amount * 3_600_000);
  const local = isoToOfficeLocal(startsAt.toISOString()); // 'YYYY-MM-DDTHH:mm'
  const day = new Date(`${local.slice(0, 10)}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - amount);
  const wall = officeLocalToIso(`${day.toISOString().slice(0, 10)}${local.slice(10)}`)!;
  return new Date(new Date(wall).getTime() + (startsAt.getTime() % 60_000)); // the seconds ride along
}

/**
 * The first unknown placeholder ({Nome} included), or {nome} when the contact has no name (decision 6: never "Olá, !").
 * contactName undefined = there is no contact yet (Configurações), so {nome} is fine.
 */
export function reminderTextProblem(text: string, contactName?: string | null): string | null {
  for (const [, key] of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!(REMINDER_PLACEHOLDERS as readonly string[]).includes(key)) {
      return `Marcador desconhecido: {${key}}. Use {nome}, {titulo}, {data} ou {hora}`;
    }
  }
  if (contactName !== undefined && !contactName?.trim() && text.includes('{nome}')) {
    return 'O contato não tem nome cadastrado; tire {nome} do lembrete';
  }
  return null;
}

/** The first rule a list of reminders breaks (spec §3.2), or null. startsAt null (Configurações): "same time" compares lead times. */
export function remindersProblem(reminders: ReminderInput[], startsAt: Date | null, contactName?: string | null): string | null {
  if (reminders.length === 0) return 'Inclua pelo menos um lembrete';
  for (const r of reminders) {
    if (!r.text.trim()) return 'Digite o texto do lembrete';
    const problem = reminderTextProblem(r.text, contactName);
    if (problem) return problem;
  }
  const times = reminders.map((r) =>
    startsAt ? reminderSendAt(startsAt, r.amount, r.unit).getTime() : r.amount * (r.unit === 'days' ? 24 : 1),
  );
  return new Set(times).size < times.length ? 'Dois lembretes cairiam no mesmo horário' : null;
}

/** The placeholders filled in ({data} and {hora} in Cuiabá time). Called on save and on a reschedule, never at send time. */
export function fillReminderText(text: string, v: { nome: string; titulo: string; startsAt: string }): string {
  const [data, hora] = formatOfficeDateTime(v.startsAt).split(' ');
  const values: Record<string, string> = { nome: v.nome, titulo: v.titulo, data, hora };
  return text.replace(/\{(nome|titulo|data|hora)\}/g, (_, key: string) => values[key]);
}
```

- [ ] **Step 4: Export them and add the DTOs**

In `shared/src/index.ts`, replace

```ts
import type { ScheduledStatus } from './automation.js';
```

with

```ts
import type { ReminderUnit, ScheduledStatus } from './automation.js';
```

Replace

```ts
export {
  OFFICE_TIMEZONE, SCHEDULE_MIN_LEAD_MS, SCHEDULE_MAX_AHEAD_MS, SCHEDULE_TEXT_MAX, SCHEDULED_STATUSES, SCHEDULED_TABS,
  RETURN_TO_QUEUE_MINUTES, CLOSE_INACTIVE_HOURS, DEFAULT_AUTO_RULES, scheduleTimeProblem, officeLocalToIso, isoToOfficeLocal,
  formatOfficeDateTime,
} from './automation.js';
```

with

```ts
export {
  OFFICE_TIMEZONE, SCHEDULE_MIN_LEAD_MS, SCHEDULE_MAX_AHEAD_MS, SCHEDULE_TEXT_MAX, SCHEDULED_STATUSES, SCHEDULED_TABS,
  RETURN_TO_QUEUE_MINUTES, CLOSE_INACTIVE_HOURS, DEFAULT_AUTO_RULES, scheduleTimeProblem, officeLocalToIso, isoToOfficeLocal,
  formatOfficeDateTime,
  REMINDER_UNITS, APPOINTMENT_LIMITS, REMINDER_PLACEHOLDERS, APPOINTMENT_TABS, DEFAULT_APPOINTMENT_REMINDERS, appointmentTimeProblem,
  reminderSendAt, reminderTextProblem, remindersProblem, fillReminderText,
} from './automation.js';
```

Replace

```ts
  | 'message_scheduled' | 'scheduled_canceled' | 'returned_to_queue';
```

with

```ts
  | 'message_scheduled' | 'scheduled_canceled' | 'returned_to_queue'
  // spec 2026-10-21 compromissos: data { appointmentId, title, startsAt, edited? } | { appointmentId, title } (never the note)
  | 'appointment_scheduled' | 'appointment_canceled';
```

Replace

```ts
  // the author or an admin, while still pending
  canEdit: boolean }
```

with

```ts
  // the author or an admin, while still pending; never for an appointment's reminder (spec 2026-10-21 compromissos §3.7)
  canEdit: boolean;
  // the appointment of a reminder; optional so existing literals compile, the server always fills it
  appointment?: { id: string; title: string } | null }
/** Spec 2026-10-21 compromissos §5.2. status 'skipped' = "Não criado": no scheduled message (its send time had passed). */
export interface AppointmentReminderDto { id: string; amount: number; unit: ReminderUnit; text: string; sendAt: string;
  status: ScheduledStatus | 'skipped'; scheduledId: string | null; error: string | null }
/** `chatId` = the chat it was made in; reminders next first; canEdit = the author or an admin, who sees that chat, until cancelled. */
export interface AppointmentDto { id: string; chatId: string; contact: { id: string; name: string | null; phone: string | null };
  authorId: string; authorName: string; title: string; startsAt: string; note: string | null; canceledAt: string | null;
  canceledByName: string | null; createdAt: string; reminders: AppointmentReminderDto[]; canEdit: boolean }
```

- [ ] **Step 5: Add the tables and the column**

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
  ReminderUnit, ScheduledStatus, UserPreferences,
} from '@talk/shared';
```

Replace

```ts
/**
 * Spec 2026-10-20 agendamentos §3: a message to send later as `author_id`. pending → sending (claimed) → sent | failed,
 * or pending → canceled. The file is saved when it is scheduled; `message_id` is the message it became.
 */
export const scheduledMessages = pgTable(
```

with

```ts
/**
 * Spec 2026-10-21 compromissos §5.1: an appointment kept by hand, tied to one chat (its contact comes from the chat).
 * No status column: cancelled = canceled_at set; upcoming / past compare starts_at with now.
 */
export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull().references(() => users.id),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    note: text('note'), // internal; never sent, never in an event
    signature: boolean('signature').notNull().default(true), // "Enviar com minha assinatura", applied to the reminders
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    canceledBy: uuid('canceled_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('appointments_starts_at_idx').on(t.startsAt), index('appointments_chat_idx').on(t.chatId)],
);

/** One reminder of an appointment; its scheduled message (if any) points back through scheduled_messages.reminder_id. */
export const appointmentReminders = pgTable(
  'appointment_reminders',
  {
    id: id(),
    appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    unit: text('unit').$type<ReminderUnit>().notNull(),
    text: text('text').notNull(), // with the placeholders, to fill them again on a reschedule
    createdAt: createdAt(),
  },
  (t) => [index('appointment_reminders_appointment_idx').on(t.appointmentId)],
);

/**
 * Spec 2026-10-20 agendamentos §3: a message to send later as `author_id`. pending → sending (claimed) → sent | failed,
 * or pending → canceled. The file is saved when it is scheduled; `message_id` is the message it became.
 */
export const scheduledMessages = pgTable(
```

Then replace

```ts
    error: text('error'), // pt-BR reason of a failure (never gateway text)
    createdAt: createdAt(),
  },
  (t) => [index('scheduled_messages_due_idx').on(t.status, t.sendAt), index('scheduled_messages_chat_idx').on(t.chatId)],
);
```

with

```ts
    error: text('error'), // pt-BR reason of a failure (never gateway text)
    createdAt: createdAt(),
    // spec 2026-10-21 compromissos §5.1 (decision 1): the appointment reminder this row sends; null for a plain scheduled message
    reminderId: uuid('reminder_id').references(() => appointmentReminders.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('scheduled_messages_due_idx').on(t.status, t.sendAt),
    index('scheduled_messages_chat_idx').on(t.chatId),
    // at most one scheduled message per reminder; NULLs never collide
    uniqueIndex('scheduled_messages_reminder_unique').on(t.reminderId),
  ],
);
```

- [ ] **Step 6: Generate the migration**

Run: `npm run db:generate -w server -- --name compromissos`
Expected: it creates `server/drizzle/0009_compromissos.sql` and `server/drizzle/meta/0009_snapshot.json`. It also adds the `0009_compromissos` entry (idx 9) to `_journal.json`, after `0008_agendamentos_e_regras`.

Run: `grep -E '^(CREATE|ALTER|DROP)' server/drizzle/0009_compromissos.sql`
Expected: exactly 12 lines, in any order:
- `CREATE TABLE "appointment_reminders" (` and `CREATE TABLE "appointments" (`;
- `ALTER TABLE "scheduled_messages" ADD COLUMN "reminder_id" uuid;…`;
- five `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` lines:
  - reminders → appointments, cascade;
  - appointments → chats, cascade;
  - appointments author → users, no action;
  - appointments canceled_by → users, set null;
  - scheduled_messages → appointment_reminders, set null;
- three `CREATE INDEX` lines (`appointments_starts_at_idx`, `appointments_chat_idx`, `appointment_reminders_appointment_idx`);
- `CREATE UNIQUE INDEX "scheduled_messages_reminder_unique" …`.

Anything else means the schema and the 0008 snapshot disagree, for example a statement about `scheduled_messages.status` or `messages.scheduled`. In that case stop: do not edit the SQL or the snapshot, and report it.

- [ ] **Step 7: Describe the new events on the web**

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
    case 'appointment_scheduled': {
      const when = typeof e.data.startsAt === 'string' ? ` para ${formatOfficeDateTime(e.data.startsAt)}` : '';
      return `Compromisso “${String(e.data.title ?? '')}” ${e.data.edited === true ? 'remarcado' : 'marcado'}${by}${when}`;
    }
    case 'appointment_canceled':
      return `Compromisso “${String(e.data.title ?? '')}” cancelado${by}`;
  }
```

- [ ] **Step 8: Run the tests and the type check**

Run: `npm test -w server -- test/automation/appointment-rules.test.ts test/db/schema.test.ts`
Expected: PASS.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors in any workspace.

- [ ] **Step 9: Commit**

```bash
git add shared/src/automation.ts shared/src/index.ts server/src/db/schema.ts server/drizzle/0009_compromissos.sql server/drizzle/meta/0009_snapshot.json server/drizzle/meta/_journal.json server/test/automation/appointment-rules.test.ts server/test/db/schema.test.ts web/src/components/conversation/model.ts web/src/components/conversation/model.test.ts
git commit -m "feat(shared,server): appointment rules, appointments tables and scheduled_messages.reminder_id (migration 0009)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Create an appointment, list them (API)

This task creates appointments in a chat or by `contactId`. Each valid reminder becomes a scheduled message; the others stay "Não criado". It also adds the two lists. Editing and cancelling come in Task 3.

**Files:**
- Modify: `server/src/catalog/settings.ts` (`@talk/shared` import, `reminderList` after `getAutoRules`)
- Modify: `server/src/automation/scheduled.ts` (export `canManage`)
- Create: `server/src/automation/appointments.ts`
- Modify: `server/src/automation/routes.ts` (imports, schemas, three routes)
- Modify: `server/test/automation/seed.ts` (`insertAppointment`)
- Test: `server/test/automation/appointments-api.test.ts` (create)

**Interfaces:**
- Consumes:
  - Task 1: the tables, `appointmentTimeProblem`, `reminderSendAt`, `remindersProblem`, `fillReminderText`, `AppointmentDto`, `AppointmentTab`, `APPOINTMENT_TABS`, `APPOINTMENT_LIMITS`, `REMINDER_UNITS`, the `appointment_scheduled` event;
  - existing: `getChatForUser`, `visibleChatsWhere`, `canSee`, `addEvent`, `scheduleTimeProblem`.
- Produces:
  - `reminderList`, `canManage` (exported);
  - `createAppointment`, `listChatAppointments`, `listAppointments`, `NO_CHAT_WITH_CONTACT`, `AppointmentInput`;
  - `POST /api/appointments`, `GET /api/chats/:id/appointments`, `GET /api/appointments`;
  - the test seed `insertAppointment(ctx, values)` (used by Tasks 2 and 4).

- [ ] **Step 1: Write the test seed**

In `server/test/automation/seed.ts`, replace

```ts
import type { AppCtx } from '../../src/ctx.js';
import { botRuns, botVersions, bots, scheduledMessages } from '../../src/db/schema.js';
```

with

```ts
import type { AppCtx } from '../../src/ctx.js';
import { appointmentReminders, appointments, botRuns, botVersions, bots, scheduledMessages } from '../../src/db/schema.js';
```

and append at the end of the file:

```ts
type AppointmentInsert = typeof appointments.$inferInsert;

/** An appointment with one "1 hora antes" reminder and no scheduled message ("Não criado"), written directly (no route, no event). */
export async function insertAppointment(
  ctx: AppCtx,
  values: Pick<AppointmentInsert, 'chatId' | 'authorId' | 'startsAt'> & Partial<AppointmentInsert>,
): Promise<{ id: string; reminderId: string }> {
  const [a] = await ctx.db.insert(appointments).values({ title: 'Audiência', ...values }).returning({ id: appointments.id });
  const [r] = await ctx.db
    .insert(appointmentReminders)
    .values({ appointmentId: a!.id, amount: 1, unit: 'hours', text: 'Olá, {nome}! Hoje às {hora}.' })
    .returning({ id: appointmentReminders.id });
  return { id: a!.id, reminderId: r!.id };
}
```

- [ ] **Step 2: Write the failing tests**

Create `server/test/automation/appointments-api.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto } from '@talk/shared';
import { NO_CHAT_WITH_CONTACT } from '../../src/automation/appointments.js';
import { appointmentReminders, appointments, contacts, scheduledMessages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat } from '../inbox/fixtures.js';
import { insertAppointment } from './seed.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const [TWO_DAYS, ONE_HOUR] = DEFAULT_APPOINTMENT_REMINDERS.reminders;

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let ana: Record<string, string>;
let chatId: string;
let contactId: string;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z (09:00 in Cuiabá)
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ana = (await loginAs(app, s.agentA.email)).headers;
  ({ chatId, contactId } = await seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, name: 'Maria Cliente', phone: '5565999999999',
  }));
});
afterEach(async () => {
  await app.close();
});

/** `ms` after the fake clock (the server checks the limits against ctx.botRuntime.now()). */
const after = (ms: number) => new Date(ctx.clock.now().getTime() + ms).toISOString();
const dateIn = (ms: number) => new Date(ctx.clock.now().getTime() + ms);
const create = (payload: object, headers = ana) => app.inject({ method: 'POST', url: '/api/appointments', headers, payload });
/** In Ana's chat, 17/10/2026 14:00 in Cuiabá, with the two default reminders. */
const base = (over: object = {}) => ({ chatId, title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z', reminders: [TWO_DAYS, ONE_HOUR], ...over });
const rows = () => ctx.db.select().from(scheduledMessages).orderBy(scheduledMessages.sendAt);

describe('POST /api/appointments (spec 2026-10-21 compromissos §3.1–3.2)', () => {
  it('from the chat: saves it, turns each reminder into a scheduled message as the author, records the event and publishes', async () => {
    const res = await create(base({ note: '  Levar RG  ', signature: false }));
    expect(res.statusCode).toBe(200);
    const dto = res.json() as AppointmentDto;
    expect(dto).toMatchObject({
      chatId, title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z', note: 'Levar RG', canceledAt: null, canceledByName: null,
      canEdit: true, authorId: s.agentA.id, authorName: 'Ana Financeiro',
      contact: { id: contactId, name: 'Maria Cliente', phone: '5565999999999' },
    });
    const [first, second] = await rows();
    expect(first).toMatchObject({
      chatId, authorId: s.agentA.id, signature: false, status: 'pending', sendAt: new Date('2026-10-15T18:00:00.000Z'),
      body: 'Olá, Maria Cliente! Lembramos do seu compromisso (Audiência) no dia 17/10/2026, às 14:00 (horário de Cuiabá). Qualquer dúvida, é só responder esta mensagem.',
    });
    expect(second).toMatchObject({
      signature: false, sendAt: new Date('2026-10-17T17:00:00.000Z'),
      body: 'Olá, Maria Cliente! Seu compromisso (Audiência) é às 14:00 de 17/10/2026 (horário de Cuiabá).',
    });
    expect(dto.reminders.map((r) => [r.amount, r.unit, r.status, r.sendAt, r.scheduledId])).toEqual([
      [2, 'days', 'pending', '2026-10-15T18:00:00.000Z', first!.id],
      [1, 'hours', 'pending', '2026-10-17T17:00:00.000Z', second!.id],
    ]);
    // the reminder keeps the placeholders, to fill them again on a reschedule
    expect((await ctx.db.select().from(appointmentReminders)).map((r) => r.text).sort()).toEqual([TWO_DAYS!.text, ONE_HOUR!.text].sort());
    expect([first!.reminderId, second!.reminderId].sort()).toEqual(dto.reminders.map((r) => r.id).sort());
    const events = await eventsOf(ctx, chatId);
    expect(events.map((e) => [e.kind, e.data, e.authorId])).toEqual([
      ['appointment_scheduled', { appointmentId: dto.id, title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z' }, s.agentA.id],
    ]);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
  });

  it('a reminder whose send time is under 2 minutes away is saved "Não criado"; with all of them so, the appointment saves anyway', async () => {
    // in 1 h 05 min: "2 dias antes" already passed, "1 hora antes" goes in 5 minutes
    const soon = (await create(base({ startsAt: after(65 * MIN) }))).json() as AppointmentDto;
    expect(soon.reminders.map((r) => [r.unit, r.status, r.scheduledId === null])).toEqual([
      ['days', 'skipped', true],
      ['hours', 'pending', false],
    ]);
    expect((await rows()).map((r) => [r.sendAt.toISOString(), r.signature])).toEqual([[after(5 * MIN), true]]); // signature on by default
    // in 61 min: "1 hora antes" would be 1 minute from now
    const tooSoon = await create(base({ startsAt: after(61 * MIN), reminders: [ONE_HOUR] }));
    expect(tooSoon.statusCode).toBe(200);
    expect((tooSoon.json() as AppointmentDto).reminders).toMatchObject([{ status: 'skipped', scheduledId: null, sendAt: after(MIN), error: null }]);
    expect(await rows()).toHaveLength(1);
  });

  it('refuses a time out of bounds and bad reminders (400), a hidden or private chat (404), and no Origin (403)', async () => {
    const err = async (payload: object) => {
      const r = await create(payload);
      return [r.statusCode, r.json().error];
    };
    expect(await err(base({ startsAt: after(-MIN) }))).toEqual([400, 'Este horário já passou; escolha uma data e hora futuras']);
    expect(await err(base({ startsAt: after(366 * DAY) }))).toEqual([400, 'Escolha um horário em até 1 ano']);
    expect(await err(base({ reminders: [{ ...ONE_HOUR, text: 'Olá, {Nome}!' }] }))).toEqual([
      400, 'Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}',
    ]);
    expect(await err(base({ reminders: [{ amount: 2, unit: 'days', text: 'Oi' }, { amount: 48, unit: 'hours', text: 'Oi' }] }))).toEqual([
      400, 'Dois lembretes cairiam no mesmo horário',
    ]);
    for (const payload of [
      base({ reminders: [] }),
      base({ reminders: Array.from({ length: 6 }, (_, i) => ({ amount: i + 1, unit: 'hours', text: 'Oi' })) }),
      base({ reminders: [{ amount: 31, unit: 'days', text: 'Oi' }] }),
      base({ reminders: [{ amount: 49, unit: 'hours', text: 'Oi' }] }),
      base({ reminders: [{ amount: 0, unit: 'hours', text: 'Oi' }] }),
      base({ reminders: [{ amount: 1, unit: 'weeks', text: 'Oi' }] }),
      base({ reminders: [{ ...ONE_HOUR, text: '   ' }] }),
      base({ title: '  ' }),
      base({ title: 'x'.repeat(121) }),
      base({ note: 'x'.repeat(2001) }),
      base({ startsAt: '2026-10-17 14:00' }),
      base({ contactId }), // both chatId and contactId
      { title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z', reminders: [ONE_HOUR] }, // neither
    ]) {
      expect((await create(payload)).statusCode).toBe(400);
    }

    // {nome} for a contact without a name (decision 6)
    const nameless = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565988887777' });
    await ctx.db.update(contacts).set({ name: null }).where(eq(contacts.id, nameless.contactId));
    expect(await err(base({ chatId: nameless.chatId }))).toEqual([400, 'O contato não tem nome cadastrado; tire {nome} do lembrete']);
    expect((await create(base({ chatId: nameless.chatId, reminders: [{ ...ONE_HOUR, text: 'Seu compromisso é às {hora}.' }] }))).statusCode).toBe(200);

    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await create(base(), bruno)).statusCode).toBe(404);
    const brunosPrivate = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id, private: true, phone: '5565977776666',
    });
    expect((await create(base({ chatId: brunosPrivate.chatId }))).statusCode).toBe(404);
    expect((await create(base(), { cookie: ana.cookie! })).statusCode).toBe(403);
    expect(await ctx.db.select().from(appointments)).toHaveLength(1); // only the nameless one without {nome}
  });

  it('a closed chat and a WhatsApp history chat are accepted (decision 8)', async () => {
    const closed = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, state: 'closed', phone: '5565966665555' });
    expect((await create(base({ chatId: closed.chatId }))).statusCode).toBe(200);
    const history = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, state: 'closed', history: true });
    expect((await create(base({ chatId: history }))).statusCode).toBe(200);
  });

  it('by contactId: the open chat the user sees, else the newest one they see; none → 400; no such contact → 404 (Review Focus 3)', async () => {
    const byContact = (id: string) => create({ ...base(), chatId: undefined, contactId: id });
    // Maria: her open chat wins over an older closed one
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, state: 'closed', at: new Date('2026-10-01T12:00:00Z') });
    expect((await byContact(contactId)).json()).toMatchObject({ chatId });

    // João: his open chat is in Bruno's sector, so Ana gets the newest of the two closed ones she sees
    const joao = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id, phone: '5565955554444', name: 'João' });
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: joao.contactId, state: 'closed', at: new Date('2026-10-01T12:00:00Z') });
    const newest = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, contactId: joao.contactId, state: 'closed', at: new Date('2026-10-10T12:00:00Z'),
    });
    expect((await byContact(joao.contactId)).json()).toMatchObject({ chatId: newest.chatId });

    // a contact Ana has no chat with
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, phone: '5565944443333' });
    const none = await byContact(other.contactId);
    expect([none.statusCode, none.json().error]).toEqual([400, NO_CHAT_WITH_CONTACT]);
    expect((await byContact('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('listing (spec §3.4–3.5)', () => {
  it("the chat lists the contact's upcoming appointments in every chat the user sees, next first (Review Focus 3)", async () => {
    const closed = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, state: 'closed', at: new Date('2026-10-01T12:00:00Z') });
    const hidden = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, contactId, state: 'closed', at: new Date('2026-10-02T12:00:00Z') });
    const later = await insertAppointment(ctx, { chatId, authorId: s.agentB.id, startsAt: dateIn(3 * DAY) });
    const sooner = await insertAppointment(ctx, { chatId: closed.chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    await insertAppointment(ctx, { chatId: hidden.chatId, authorId: s.agentA.id, startsAt: dateIn(2 * DAY) }); // a chat Ana cannot see
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(2 * DAY), canceledAt: dateIn(0) });
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-HOUR) }); // already passed
    const list = (headers = ana, id = chatId) => app.inject({ method: 'GET', url: `/api/chats/${id}/appointments`, headers });

    const dtos = (await list()).json() as AppointmentDto[];
    expect(dtos.map((d) => [d.id, d.canEdit])).toEqual([[sooner.id, true], [later.id, false]]); // Bruno's: no Editar for Ana
    expect(dtos[0]!.reminders).toMatchObject([{ amount: 1, unit: 'hours', status: 'skipped', scheduledId: null, sendAt: dateIn(DAY - HOUR).toISOString() }]);
    // the same list from the contact's other chat
    expect(((await list(ana, closed.chatId)).json() as AppointmentDto[]).map((d) => d.id)).toEqual([sooner.id, later.id]);
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await list(bruno)).statusCode).toBe(404);
  });

  it("the Agenda tab lists an agent's own appointments and everyone's for an admin, by tab, in order, up to 100", async () => {
    const mineSoon = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    const mineLater = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(2 * DAY) });
    const brunos = await insertAppointment(ctx, { chatId, authorId: s.agentB.id, startsAt: dateIn(HOUR) });
    const pastOld = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-2 * DAY) });
    const pastNew = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-HOUR) });
    const canceled = await insertAppointment(ctx, {
      chatId, authorId: s.agentA.id, startsAt: dateIn(DAY), canceledAt: dateIn(0), canceledBy: s.agentA.id,
    });
    const admin = (await loginAs(app, s.admin.email)).headers;
    const get = (headers: Record<string, string>, tab: string) => app.inject({ method: 'GET', url: `/api/appointments?tab=${tab}`, headers });
    const ids = async (headers: Record<string, string>, tab: string) => ((await get(headers, tab)).json() as AppointmentDto[]).map((d) => d.id);

    expect(await ids(ana, 'upcoming')).toEqual([mineSoon.id, mineLater.id]);
    expect(await ids(admin, 'upcoming')).toEqual([brunos.id, mineSoon.id, mineLater.id]); // next first
    expect(await ids(ana, 'past')).toEqual([pastNew.id, pastOld.id]); // newest first
    expect(await ids(ana, 'canceled')).toEqual([canceled.id]);
    expect(((await get(ana, 'canceled')).json() as AppointmentDto[])[0]).toMatchObject({ canceledByName: 'Ana Financeiro', canEdit: false });
    expect((await get(ana, 'nope')).statusCode).toBe(400);

    await ctx.db.insert(appointments).values(
      Array.from({ length: 100 }, (_, i) => ({ chatId, authorId: s.agentA.id, title: `C${i}`, startsAt: dateIn(3 * DAY + i * MIN) })),
    );
    expect(await ids(ana, 'upcoming')).toHaveLength(100);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test -w server -- test/automation/appointments-api.test.ts`
Expected: FAIL. `../../src/automation/appointments.js` does not exist.

- [ ] **Step 4: Share the reminder list schema and `canManage`**

In `server/src/catalog/settings.ts`, replace

```ts
import {
  CLOSE_INACTIVE_HOURS, DEFAULT_AUTO_RULES, RETURN_TO_QUEUE_MINUTES, type AutoRulesDto, type BotRunningBehavior, type SettingsDto,
} from '@talk/shared';
```

with

```ts
import {
  APPOINTMENT_LIMITS, CLOSE_INACTIVE_HOURS, DEFAULT_AUTO_RULES, REMINDER_UNITS, RETURN_TO_QUEUE_MINUTES, SCHEDULE_TEXT_MAX,
  type AutoRulesDto, type BotRunningBehavior, type SettingsDto,
} from '@talk/shared';
```

and replace

```ts
  return parsed.success ? parsed.data : DEFAULT_AUTO_RULES;
}
```

with

```ts
  return parsed.success ? parsed.data : DEFAULT_AUTO_RULES;
}

/**
 * Spec 2026-10-21 compromissos §3.2: 1 to 5 reminders, 1–30 days or 1–48 hours before, 1–4096 characters each. The create
 * route and the default reminders (§4) read the same list; the placeholder and same-time rules are remindersProblem.
 */
export const reminderList = z
  .array(
    z
      .object({ amount: z.number().int(), unit: z.enum(REMINDER_UNITS), text: z.string().trim().min(1).max(SCHEDULE_TEXT_MAX) })
      .refine((r) => r.amount >= APPOINTMENT_LIMITS[r.unit].min && r.amount <= APPOINTMENT_LIMITS[r.unit].max),
  )
  .min(1)
  .max(APPOINTMENT_LIMITS.remindersMax);
```

In `server/src/automation/scheduled.ts`, replace

```ts
const canManage = (user: AuthUser, row: { authorId: string }) => row.authorId === user.id || user.role === 'admin';
```

with

```ts
/** The author or any admin (spec 2026-10-20 agendamentos §3.2); appointments use the same rule (spec 2026-10-21 compromissos §3.3). */
export const canManage = (user: AuthUser, row: { authorId: string }) => row.authorId === user.id || user.role === 'admin';
```

- [ ] **Step 5: Write the service**

Create `server/src/automation/appointments.ts`:

```ts
// Spec 2026-10-21 compromissos §3: an appointment and its reminders. Each reminder that can still go out is an ordinary
// scheduled message (scheduled_messages.reminder_id), sent by delivery.ts like any other. This module only creates,
// moves in place, deletes (pending only) and cancels those rows, always with status = 'pending' in the WHERE.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  appointmentTimeProblem, fillReminderText, reminderSendAt, remindersProblem, scheduleTimeProblem, type AppointmentDto,
  type AppointmentTab, type ReminderInput,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { appointmentReminders, appointments, chats, contacts, scheduledMessages, users } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { canSee, visibleChatsWhere, type AuthUser } from '../inbox/visibility.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { canManage } from './scheduled.js';

export const NO_CHAT_WITH_CONTACT = 'Você não tem conversa com este contato; comece uma em Nova conversa';
// ponytail: one page of 100 per tab, no cursor (spec §10); add keyset paging on (starts_at, id) if an office ever keeps more.
const LIST_LIMIT = 100;

/** POST /api/appointments; the route makes sure exactly one of chatId / contactId is set. */
export interface AppointmentInput {
  chatId?: string; contactId?: string; title: string; startsAt: Date; note: string | null; signature: boolean; reminders: ReminderInput[];
}

const canceler = alias(users, 'canceler');

/** The appointments `where` picks (over appointments ⋈ chats), with the contact, the names and each reminder's situation. */
async function appointmentDtos(db: Db, user: AuthUser, where: SQL | undefined, order: SQL[]): Promise<AppointmentDto[]> {
  const rows = await db
    .select({
      a: appointments,
      chat: { sectorId: chats.sectorId, ownerId: chats.ownerId, private: chats.private, history: chats.history },
      contactId: contacts.id, contactName: contacts.name, contactPhone: contacts.phone,
      authorName: users.name, canceledByName: canceler.name,
    })
    .from(appointments)
    .innerJoin(chats, eq(chats.id, appointments.chatId))
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(users, eq(users.id, appointments.authorId))
    .leftJoin(canceler, eq(canceler.id, appointments.canceledBy))
    .where(where)
    .orderBy(...order)
    .limit(LIST_LIMIT);
  if (rows.length === 0) return [];
  // a reminder without a scheduled message is "Não criado" ('skipped')
  const reminders = await db
    .select({
      r: appointmentReminders, scheduledId: scheduledMessages.id, sendAt: scheduledMessages.sendAt,
      status: scheduledMessages.status, error: scheduledMessages.error,
    })
    .from(appointmentReminders)
    .leftJoin(scheduledMessages, eq(scheduledMessages.reminderId, appointmentReminders.id))
    .where(inArray(appointmentReminders.appointmentId, rows.map((row) => row.a.id)));
  return rows.map(({ a, chat, ...r }) => ({
    id: a.id,
    chatId: a.chatId,
    contact: { id: r.contactId, name: r.contactName, phone: r.contactPhone },
    authorId: a.authorId,
    authorName: r.authorName,
    title: a.title,
    startsAt: a.startsAt.toISOString(),
    note: a.note,
    canceledAt: a.canceledAt?.toISOString() ?? null,
    canceledByName: r.canceledByName,
    createdAt: a.createdAt.toISOString(),
    reminders: reminders
      .filter((x) => x.r.appointmentId === a.id)
      .map((x) => ({
        id: x.r.id,
        amount: x.r.amount,
        unit: x.r.unit,
        text: x.r.text,
        sendAt: (x.sendAt ?? reminderSendAt(a.startsAt, x.r.amount, x.r.unit)).toISOString(),
        status: x.status ?? 'skipped',
        scheduledId: x.scheduledId,
        error: x.error,
      }))
      .sort((p, q) => p.sendAt.localeCompare(q.sendAt)),
    // decision: also needs the chat, like every write (spec §2)
    canEdit: !a.canceledAt && canManage(user, a) && canSee(user, chat),
  }));
}

async function dtoOf(db: Db, user: AuthUser, id: string): Promise<AppointmentDto> {
  const [dto] = await appointmentDtos(db, user, eq(appointments.id, id), [asc(appointments.id)]);
  if (!dto) throw notFound();
  return dto;
}

async function contactNameOf(db: Db, contactId: string): Promise<string | null> {
  const [c] = await db.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, contactId));
  return c?.name?.trim() || null;
}

/** The text a reminder's scheduled message carries: the placeholders filled now (spec §3.2), never at send time. */
function filled(text: string, a: { title: string; startsAt: Date }, name: string | null): string {
  return fillReminderText(text, { nome: name ?? '', titulo: a.title, startsAt: a.startsAt.toISOString() });
}

/** Spec §3.1 (decision 8): the contact's open chat the user sees, else their newest one the user sees; none → 400. */
async function chatForContact(ctx: AppCtx, user: AuthUser, contactId: string): Promise<ChatRow> {
  const [contact] = await ctx.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId));
  if (!contact) throw notFound('Contato não encontrado.');
  const [chat] = await ctx.db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, contactId), visibleChatsWhere(user)))
    .orderBy(desc(eq(chats.state, 'open')), desc(chats.createdAt), desc(chats.id))
    .limit(1);
  if (!chat) throw badRequest(NO_CHAT_WITH_CONTACT);
  return chat;
}

/** Spec §3.1–3.2: the appointment, its reminders, a scheduled message per reminder that can still go out, and the event. */
export async function createAppointment(ctx: AppCtx, user: AuthUser, input: AppointmentInput): Promise<AppointmentDto> {
  const chat = input.chatId ? await getChatForUser(ctx, user, input.chatId) : await chatForContact(ctx, user, input.contactId!);
  const now = ctx.botRuntime.now();
  const name = await contactNameOf(ctx.db, chat.contactId);
  const problem = appointmentTimeProblem(input.startsAt, now) ?? remindersProblem(input.reminders, input.startsAt, name);
  if (problem) throw badRequest(problem);
  const id = randomUUID();
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  await ctx.db.transaction(async (tx) => {
    await tx.insert(appointments).values({
      id, chatId: chat.id, authorId: user.id, title: input.title, startsAt: input.startsAt, note: input.note, signature: input.signature,
    });
    const reminders = await tx
      .insert(appointmentReminders)
      .values(input.reminders.map((r) => ({ appointmentId: id, amount: r.amount, unit: r.unit, text: r.text })))
      .returning();
    for (const r of reminders) {
      const sendAt = reminderSendAt(input.startsAt, r.amount, r.unit);
      if (scheduleTimeProblem(sendAt, now)) continue; // "Não criado": saved without a scheduled message
      await tx.insert(scheduledMessages).values({
        chatId: chat.id, authorId: user.id, body: filled(r.text, input, name), signature: input.signature, sendAt, reminderId: r.id,
      });
    }
    await addEvent(tx, chat.id, 'appointment_scheduled', { appointmentId: id, title: input.title, startsAt: input.startsAt.toISOString() }, user.id);
  });
  await ctx.hub.publishChat(chat.id); // open screens refetch the timeline, the strip and the appointments
  return dtoOf(ctx.db, user, id);
}

/** Spec §3.4: the contact's upcoming appointments, in every chat of theirs the user sees, next first. */
export async function listChatAppointments(ctx: AppCtx, user: AuthUser, chatId: string): Promise<AppointmentDto[]> {
  const chat = await getChatForUser(ctx, user, chatId);
  return appointmentDtos(
    ctx.db,
    user,
    and(eq(chats.contactId, chat.contactId), visibleChatsWhere(user), isNull(appointments.canceledAt), gte(appointments.startsAt, ctx.botRuntime.now())),
    [asc(appointments.startsAt), asc(appointments.id)],
  );
}

/** Spec §3.5: the Agenda's "Compromissos": mine (an admin: everyone's); Próximos next first, the other tabs newest first. */
export async function listAppointments(ctx: AppCtx, user: AuthUser, tab: AppointmentTab): Promise<AppointmentDto[]> {
  const now = ctx.botRuntime.now();
  const mine = user.role === 'admin' ? undefined : eq(appointments.authorId, user.id);
  const when =
    tab === 'canceled'
      ? isNotNull(appointments.canceledAt)
      : and(isNull(appointments.canceledAt), tab === 'upcoming' ? gte(appointments.startsAt, now) : lt(appointments.startsAt, now));
  const order =
    tab === 'upcoming' ? [asc(appointments.startsAt), asc(appointments.id)] : [desc(appointments.startsAt), desc(appointments.id)];
  return appointmentDtos(ctx.db, user, and(when, mine), order);
}
```

- [ ] **Step 6: Write the routes**

In `server/src/automation/routes.ts`, replace

```ts
import { SCHEDULE_TEXT_MAX, SCHEDULED_TABS } from '@talk/shared';
import { readParts } from '../chats/routes.js';
import type { AppCtx } from '../ctx.js';
import { cancelScheduled, createScheduled, listChatScheduled, listScheduled, updateScheduled } from './scheduled.js';
```

with

```ts
import { APPOINTMENT_LIMITS, APPOINTMENT_TABS, SCHEDULE_TEXT_MAX, SCHEDULED_TABS } from '@talk/shared';
import { reminderList } from '../catalog/settings.js';
import { readParts } from '../chats/routes.js';
import type { AppCtx } from '../ctx.js';
import { createAppointment, listAppointments, listChatAppointments } from './appointments.js';
import { cancelScheduled, createScheduled, listChatScheduled, listScheduled, updateScheduled } from './scheduled.js';
```

replace

```ts
const listQuery = z.object({ status: z.enum(SCHEDULED_TABS).default('pending') });
```

with

```ts
const listQuery = z.object({ status: z.enum(SCHEDULED_TABS).default('pending') });
const appointmentTitle = z.string().trim().min(1).max(APPOINTMENT_LIMITS.titleMax);
const appointmentNote = z.string().trim().max(APPOINTMENT_LIMITS.noteMax);
/** Spec 2026-10-21 compromissos §5.3: exactly one of chatId / contactId. */
const appointmentBody = z
  .object({
    chatId: z.uuid().optional(),
    contactId: z.uuid().optional(),
    title: appointmentTitle,
    startsAt: sendAt, // the same ISO instant with an offset
    note: appointmentNote.optional(),
    signature: z.boolean().default(true), // "Enviar com minha assinatura" (§3.1)
    reminders: reminderList,
  })
  .refine((b) => (b.chatId === undefined) !== (b.contactId === undefined), 'Escolha o cliente');
const appointmentQuery = z.object({ tab: z.enum(APPOINTMENT_TABS).default('upcoming') });
```

and replace

```ts
  app.post('/api/scheduled-messages/:id/cancel', async (req) => cancelScheduled(ctx, req.user, idParams.parse(req.params).id));
}
```

with

```ts
  app.post('/api/scheduled-messages/:id/cancel', async (req) => cancelScheduled(ctx, req.user, idParams.parse(req.params).id));

  // Spec 2026-10-21 compromissos §5.3.
  app.post('/api/appointments', async (req) => {
    const b = appointmentBody.parse(req.body);
    return createAppointment(ctx, req.user, { ...b, startsAt: new Date(b.startsAt), note: b.note || null });
  });

  app.get('/api/chats/:id/appointments', async (req) => listChatAppointments(ctx, req.user, idParams.parse(req.params).id));

  app.get('/api/appointments', async (req) => listAppointments(ctx, req.user, appointmentQuery.parse(req.query).tab));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/automation/appointments-api.test.ts`
Expected: PASS.

Run: `npm test -w server -- test/automation test/catalog` and `npm run typecheck -w server`
Expected: PASS, no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/catalog/settings.ts server/src/automation/scheduled.ts server/src/automation/appointments.ts server/src/automation/routes.ts server/test/automation/seed.ts server/test/automation/appointments-api.test.ts
git commit -m "feat(server): create appointments with their reminders as scheduled messages, and list them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Edit with the in-place recalculation, and cancel (API)

**Files:**
- Modify: `server/src/automation/appointments.ts` (imports, append)
- Modify: `server/src/automation/routes.ts` (import, schema, two routes)
- Test: `server/test/automation/appointments-edit.test.ts` (create)

**Interfaces:**
- Consumes:
  - Task 2: `appointmentDtos`, `dtoOf`, `contactNameOf` and `filled` (module-private, same file), `canManage`;
  - Task 1: `reminderTextProblem`, `appointment_canceled`.
- Produces: `updateAppointment`, `cancelAppointment`, `APPOINTMENT_CANCELED`, `PATCH /api/appointments/:id`, `POST /api/appointments/:id/cancel`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/automation/appointments-edit.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto } from '@talk/shared';
import { APPOINTMENT_CANCELED } from '../../src/automation/appointments.js';
import { scheduledMessages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const [TWO_DAYS, ONE_HOUR] = DEFAULT_APPOINTMENT_REMINDERS.reminders;

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let ana: Record<string, string>;
let admin: Record<string, string>;
let chatId: string;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z (09:00 in Cuiabá)
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ana = (await loginAs(app, s.agentA.email)).headers;
  admin = (await loginAs(app, (await enableSeeAll(ctx, s.admin)).email)).headers;
  ({ chatId } = await seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, name: 'Maria Cliente', phone: '5565999999999',
  }));
});
afterEach(async () => {
  await app.close();
});

const after = (ms: number) => new Date(ctx.clock.now().getTime() + ms).toISOString();
/** Ana's appointment in 3 days (17/10/2026 09:00 in Cuiabá) with the default reminders, unless `over` says otherwise. */
const create = async (over: object = {}) =>
  (
    await app.inject({
      method: 'POST', url: '/api/appointments', headers: ana,
      payload: { chatId, title: 'Audiência', startsAt: after(3 * DAY), reminders: [TWO_DAYS, ONE_HOUR], ...over },
    })
  ).json() as AppointmentDto;
const patch = (id: string, payload: object, headers = ana) => app.inject({ method: 'PATCH', url: `/api/appointments/${id}`, headers, payload });
const cancel = (id: string, headers = ana) => app.inject({ method: 'POST', url: `/api/appointments/${id}/cancel`, headers });
const scheduled = () => ctx.db.select().from(scheduledMessages).orderBy(scheduledMessages.sendAt);
/** What the worker does when it takes or finishes a row. */
const setStatus = (id: string, status: 'sending' | 'sent' | 'failed') =>
  ctx.db.update(scheduledMessages).set({ status }).where(eq(scheduledMessages.id, id));

describe('PATCH /api/appointments/:id (spec 2026-10-21 compromissos §3.3)', () => {
  it('the author or an admin edits; anyone else gets 404; a cancelled one is 409; a new past time is 400, a kept one is not checked', async () => {
    const a = await create();
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await patch(a.id, { note: 'x' }, bruno)).statusCode).toBe(404);
    expect((await patch(a.id, {})).statusCode).toBe(400);
    expect((await patch(a.id, { note: 'x' }, { cookie: ana.cookie! })).statusCode).toBe(403);
    const past = await patch(a.id, { startsAt: after(-MIN) });
    expect([past.statusCode, past.json().error]).toEqual([400, 'Este horário já passou; escolha uma data e hora futuras']);
    expect((await patch(a.id, { note: 'Levar RG' }, admin)).json()).toMatchObject({ note: 'Levar RG', canEdit: true });

    // the appointment has passed: the same time and a new note still save; "" clears the note
    ctx.clock.advance(4 * DAY);
    const kept = await patch(a.id, { startsAt: a.startsAt, note: '' });
    expect([kept.statusCode, kept.json().note]).toEqual([200, null]);

    expect((await cancel(a.id)).statusCode).toBe(200);
    const again = await patch(a.id, { note: 'y' });
    expect([again.statusCode, again.json().error]).toEqual([409, APPOINTMENT_CANCELED]);
  });

  it('a new time moves each pending reminder in place, creates the "Não criado" ones that now fit and removes the ones that no longer do', async () => {
    // in 1 day 30 min: "2 dias antes" already passed (Não criado), "1 hora antes" is pending
    const a = await create({ startsAt: after(DAY + 30 * MIN) });
    const [hourRow] = await scheduled();
    expect(a.reminders.map((r) => r.status)).toEqual(['skipped', 'pending']);

    const moved = (await patch(a.id, { startsAt: after(3 * DAY) }, admin)).json() as AppointmentDto;
    const [dayRow, sameHourRow] = await scheduled();
    expect(sameHourRow).toMatchObject({
      id: hourRow!.id, status: 'pending', sendAt: new Date(after(3 * DAY - HOUR)),
      body: 'Olá, Maria Cliente! Seu compromisso (Audiência) é às 09:00 de 17/10/2026 (horário de Cuiabá).',
    });
    // created by the admin's edit, still as the appointment's author, with its signature choice (decision 9)
    expect(dayRow).toMatchObject({ chatId, authorId: s.agentA.id, signature: true, sendAt: new Date(after(DAY)), reminderId: a.reminders[0]!.id });
    expect(moved.reminders.map((r) => r.status)).toEqual(['pending', 'pending']);

    // in 61 min: "1 hora antes" would be 1 minute away and "2 dias antes" in the past, so both go back to "Não criado"
    const tooSoon = (await patch(a.id, { startsAt: after(61 * MIN) })).json() as AppointmentDto;
    expect(await scheduled()).toEqual([]);
    expect(tooSoon.reminders.map((r) => [r.status, r.scheduledId])).toEqual([['skipped', null], ['skipped', null]]);
  });

  it('leaves sent, failed and sending rows alone and never creates them again (Review Focus 1)', async () => {
    const a = await create({ reminders: [TWO_DAYS, { ...ONE_HOUR, amount: 3 }, ONE_HOUR] });
    const [sent, failed, sending] = await scheduled();
    await setStatus(sent!.id, 'sent');
    await setStatus(failed!.id, 'failed');
    await setStatus(sending!.id, 'sending'); // the worker took it between the read and the write
    const before = await scheduled();
    const moved = (await patch(a.id, { startsAt: after(4 * DAY) })).json() as AppointmentDto;
    expect(await scheduled()).toEqual(before);
    expect(moved.reminders.map((r) => r.status)).toEqual(['sent', 'failed', 'sending']);
  });

  it('a new title fills the texts again without an event; only the note recalculates nothing; "remarcado" only when the time moves', async () => {
    const a = await create();
    const [row] = await scheduled();
    await patch(a.id, { note: 'Levar RG' });
    expect((await scheduled())[0]).toEqual(row);
    await patch(a.id, { title: 'Perícia' });
    expect((await scheduled())[0]).toMatchObject({
      id: row!.id, sendAt: row!.sendAt,
      body: 'Olá, Maria Cliente! Lembramos do seu compromisso (Perícia) no dia 17/10/2026, às 09:00 (horário de Cuiabá). Qualquer dúvida, é só responder esta mensagem.',
    });
    await patch(a.id, { startsAt: after(4 * DAY) }, admin);
    expect((await eventsOf(ctx, chatId)).map((e) => [e.kind, e.data, e.authorId])).toEqual([
      ['appointment_scheduled', { appointmentId: a.id, title: 'Audiência', startsAt: after(3 * DAY) }, s.agentA.id],
      ['appointment_scheduled', { appointmentId: a.id, title: 'Perícia', startsAt: after(4 * DAY), edited: true }, s.admin.id],
    ]);
  });

  it('a title change a minute before a reminder goes out keeps that reminder (Review Focus 1)', async () => {
    const a = await create({ startsAt: after(65 * MIN), reminders: [ONE_HOUR] });
    ctx.clock.advance(4 * MIN); // the reminder is now 1 minute away
    expect((await patch(a.id, { title: 'Perícia' })).statusCode).toBe(200);
    expect(await scheduled()).toMatchObject([{ status: 'pending', sendAt: new Date(after(MIN)), body: expect.stringContaining('(Perícia)') }]);
  });
});

describe('POST /api/appointments/:id/cancel (spec §3.3)', () => {
  it('cancels the pending reminders, keeps the ones already out or going out, records the event; twice is 409', async () => {
    const a = await create({ reminders: [TWO_DAYS, { ...ONE_HOUR, amount: 3 }, ONE_HOUR] });
    const [sent, sending, pending] = await scheduled();
    await setStatus(sent!.id, 'sent');
    await setStatus(sending!.id, 'sending');
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await cancel(a.id, bruno)).statusCode).toBe(404);
    expect((await cancel(a.id, { cookie: ana.cookie! })).statusCode).toBe(403);

    const res = await cancel(a.id);
    expect(res.json()).toMatchObject({ canceledAt: ctx.clock.now().toISOString(), canceledByName: 'Ana Financeiro', canEdit: false });
    expect((await scheduled()).map((r) => [r.id, r.status, r.finishedAt])).toEqual([
      [sent!.id, 'sent', null],
      [sending!.id, 'sending', null],
      [pending!.id, 'canceled', ctx.clock.now()],
    ]);
    expect((await eventsOf(ctx, chatId)).at(-1)).toMatchObject({
      kind: 'appointment_canceled', data: { appointmentId: a.id, title: 'Audiência' }, authorId: s.agentA.id,
    });
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    const again = await cancel(a.id);
    expect([again.statusCode, again.json().error]).toEqual([409, APPOINTMENT_CANCELED]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/automation/appointments-edit.test.ts`
Expected: FAIL. `APPOINTMENT_CANCELED` is not exported by `appointments.js`, and `PATCH` and `cancel` answer 404 (no such route).

- [ ] **Step 3: Write the edit and the cancel**

In `server/src/automation/appointments.ts`, replace

```ts
import {
  appointmentTimeProblem, fillReminderText, reminderSendAt, remindersProblem, scheduleTimeProblem, type AppointmentDto,
  type AppointmentTab, type ReminderInput,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
```

with

```ts
import {
  appointmentTimeProblem, fillReminderText, reminderSendAt, reminderTextProblem, remindersProblem, scheduleTimeProblem,
  type AppointmentDto, type AppointmentTab, type ReminderInput,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
```

replace

```ts
import { badRequest, notFound } from '../lib/http-error.js';
```

with

```ts
import { badRequest, conflict, notFound } from '../lib/http-error.js';
```

and append at the end of the file:

```ts
export const APPOINTMENT_CANCELED = 'Este compromisso foi cancelado';

type AppointmentRow = typeof appointments.$inferSelect;

/** The author's or an admin's appointment, in a chat they see (spec §2, §3.3): 404 for anyone else, 409 once cancelled. */
async function manageableRow(ctx: AppCtx, user: AuthUser, id: string): Promise<{ a: AppointmentRow; contactId: string }> {
  const [row] = await ctx.db
    .select({ a: appointments, chat: chats })
    .from(appointments)
    .innerJoin(chats, eq(chats.id, appointments.chatId))
    .where(eq(appointments.id, id));
  if (!row || !canManage(user, row.a) || !canSee(user, row.chat)) throw notFound();
  if (row.a.canceledAt) throw conflict(APPOINTMENT_CANCELED);
  return { a: row.a, contactId: row.chat.contactId };
}

/**
 * Spec §3.3, decision 2: each reminder follows the new time and title, in place.
 * - A pending row is moved, or deleted when its new time no longer fits. A time that did not move is kept, even under
 *   2 minutes away.
 * - A "Não criado" reminder gets a row once its time fits.
 * - A row the worker took (sending, sent, failed) is left alone.
 * Every write re-checks status = 'pending', so a row claimed in between goes out as it was and is never created again.
 */
async function recalcReminders(tx: Tx, a: AppointmentRow, name: string | null, now: Date): Promise<void> {
  const rows = await tx
    .select({ r: appointmentReminders, scheduledId: scheduledMessages.id, status: scheduledMessages.status, sendAt: scheduledMessages.sendAt })
    .from(appointmentReminders)
    .leftJoin(scheduledMessages, eq(scheduledMessages.reminderId, appointmentReminders.id))
    .where(eq(appointmentReminders.appointmentId, a.id));
  for (const { r, scheduledId, status, sendAt: oldSendAt } of rows) {
    const problem = reminderTextProblem(r.text, name); // the contact may have lost its name since (decision 6)
    if (problem) throw badRequest(problem);
    const sendAt = reminderSendAt(a.startsAt, r.amount, r.unit);
    const body = filled(r.text, a, name);
    const fits = !scheduleTimeProblem(sendAt, now);
    if (!scheduledId) {
      // decision 9: the appointment's author and signature, also when an admin edits
      if (fits) await tx.insert(scheduledMessages).values({ chatId: a.chatId, authorId: a.authorId, body, signature: a.signature, sendAt, reminderId: r.id });
      continue;
    }
    if (status !== 'pending') continue;
    const stillPending = and(eq(scheduledMessages.id, scheduledId), eq(scheduledMessages.status, 'pending'));
    if (fits || sendAt.getTime() === oldSendAt!.getTime()) await tx.update(scheduledMessages).set({ sendAt, body }).where(stillPending);
    else await tx.delete(scheduledMessages).where(stillPending); // back to "Não criado"; nothing points at a row that never went out
  }
}

/** Spec §3.3: title, time and note. A kept time is not checked again; only a note change recalculates nothing and records nothing. */
export async function updateAppointment(
  ctx: AppCtx,
  user: AuthUser,
  id: string,
  patch: { title?: string; startsAt?: Date; note?: string | null },
): Promise<AppointmentDto> {
  const { a, contactId } = await manageableRow(ctx, user, id);
  const now = ctx.botRuntime.now();
  const title = patch.title ?? a.title;
  const startsAt = patch.startsAt ?? a.startsAt;
  const moved = startsAt.getTime() !== a.startsAt.getTime();
  if (moved) {
    const problem = appointmentTimeProblem(startsAt, now);
    if (problem) throw badRequest(problem);
  }
  const refill = moved || title !== a.title;
  const name = refill ? await contactNameOf(ctx.db, contactId) : null;
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  const chatId = await ctx.db.transaction(async (tx) => {
    // the lock makes two edits (or an edit and a cancel) of the same appointment take turns
    const [locked] = await tx.select().from(appointments).where(eq(appointments.id, id)).for('update');
    if (!locked || locked.canceledAt) throw conflict(APPOINTMENT_CANCELED);
    await tx
      .update(appointments)
      .set({ title, startsAt, ...(patch.note !== undefined ? { note: patch.note } : {}) })
      .where(eq(appointments.id, id));
    if (refill) await recalcReminders(tx, { ...locked, title, startsAt }, name, now);
    if (moved) {
      await addEvent(tx, locked.chatId, 'appointment_scheduled', { appointmentId: id, title, startsAt: startsAt.toISOString(), edited: true }, user.id);
    }
    return locked.chatId;
  });
  await ctx.hub.publishChat(chatId);
  return dtoOf(ctx.db, user, id);
}

/** Spec §3.3: the pending reminders go to "Agenda → Canceladas"; the ones already out stay; one being sent right now goes out. */
export async function cancelAppointment(ctx: AppCtx, user: AuthUser, id: string): Promise<AppointmentDto> {
  await manageableRow(ctx, user, id);
  const now = ctx.botRuntime.now();
  const chatId = await ctx.db.transaction(async (tx) => {
    const [a] = await tx
      .update(appointments)
      .set({ canceledAt: now, canceledBy: user.id })
      .where(and(eq(appointments.id, id), isNull(appointments.canceledAt)))
      .returning();
    if (!a) throw conflict(APPOINTMENT_CANCELED);
    const reminderIds = tx.select({ id: appointmentReminders.id }).from(appointmentReminders).where(eq(appointmentReminders.appointmentId, id));
    await tx
      .update(scheduledMessages)
      .set({ status: 'canceled', finishedAt: now })
      .where(and(inArray(scheduledMessages.reminderId, reminderIds), eq(scheduledMessages.status, 'pending')));
    await addEvent(tx, a.chatId, 'appointment_canceled', { appointmentId: id, title: a.title }, user.id);
    return a.chatId;
  });
  await ctx.hub.publishChat(chatId);
  return dtoOf(ctx.db, user, id);
}
```

- [ ] **Step 4: Add the two routes**

In `server/src/automation/routes.ts`, replace

```ts
import { createAppointment, listAppointments, listChatAppointments } from './appointments.js';
```

with

```ts
import { cancelAppointment, createAppointment, listAppointments, listChatAppointments, updateAppointment } from './appointments.js';
```

replace

```ts
const appointmentQuery = z.object({ tab: z.enum(APPOINTMENT_TABS).default('upcoming') });
```

with

```ts
const appointmentQuery = z.object({ tab: z.enum(APPOINTMENT_TABS).default('upcoming') });
/** Spec §3.3: title, time and note only (decision 3); null or "" clears the note. */
const appointmentPatch = z
  .object({ title: appointmentTitle.optional(), startsAt: sendAt.optional(), note: appointmentNote.nullable().optional() })
  .refine((b) => b.title !== undefined || b.startsAt !== undefined || b.note !== undefined, 'Nada para alterar');
```

and replace

```ts
  app.get('/api/appointments', async (req) => listAppointments(ctx, req.user, appointmentQuery.parse(req.query).tab));
}
```

with

```ts
  app.get('/api/appointments', async (req) => listAppointments(ctx, req.user, appointmentQuery.parse(req.query).tab));

  app.patch('/api/appointments/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = appointmentPatch.parse(req.body);
    return updateAppointment(ctx, req.user, id, {
      title: b.title,
      startsAt: b.startsAt ? new Date(b.startsAt) : undefined,
      note: b.note === undefined ? undefined : b.note || null,
    });
  });

  app.post('/api/appointments/:id/cancel', async (req) => cancelAppointment(ctx, req.user, idParams.parse(req.params).id));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/automation/appointments-edit.test.ts test/automation/appointments-api.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/automation/appointments.ts server/src/automation/routes.ts server/test/automation/appointments-edit.test.ts
git commit -m "feat(server): edit an appointment with the reminders recalculated in place, and cancel it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reminders in the paths that already exist (Agenda, inactivity, delivery, delete, merge)

This task touches the existing paths:
- the Agenda refuses to change a reminder and marks it;
- "Finalizar por inatividade" ignores reminders;
- the LID merge keeps appointments.

Four of its tests pass on the first run and stay as guards. Three pin that delivery needs no change (spec §3.6). The fourth pins the delete cascade that Task 1's migration already set up.

**Files:**
- Modify: `server/src/automation/scheduled.ts` (import, `REMINDER_LOCKED`, `scheduledDtos`, `pendingRowFor`)
- Modify: `server/src/automation/rules.ts` (import, `closeInactiveChats`)
- Modify: `server/src/history/merge.ts` (import, `absorb`)
- Test: `server/test/automation/scheduled-api.test.ts`, `server/test/automation/rules.test.ts`, `server/test/automation/delivery.test.ts`, `server/test/history/merge.test.ts`, `server/test/chats/delete-and-unread.test.ts`

**Interfaces:**
- Consumes: Task 1 `scheduledMessages.reminderId`, `appointments`, `appointmentReminders`; Task 2 `insertAppointment`, `POST /api/appointments`; Task 3 `PATCH /api/appointments/:id`.
- Produces: `REMINDER_LOCKED`; `ScheduledMessageDto.appointment` filled; `canEdit` false for reminders; the inactivity exclusion; `absorb` moves appointments.

- [ ] **Step 1: Write the failing tests**

In `server/test/automation/scheduled-api.test.ts`, replace

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledMessageDto } from '@talk/shared';
import { NOT_PENDING } from '../../src/automation/scheduled.js';
```

with

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledMessageDto } from '@talk/shared';
import { NOT_PENDING, REMINDER_LOCKED } from '../../src/automation/scheduled.js';
```

replace `import { insertScheduled } from './seed.js';` with `import { insertAppointment, insertScheduled } from './seed.js';`, and append at the end of the file:

```ts
describe('appointment reminders in the Agenda (spec 2026-10-21 compromissos §3.7, decision 4)', () => {
  it('a reminder carries its appointment, cannot be edited or cancelled there (409), and anyone else still gets 404 (Review Focus 4)', async () => {
    const { id: appointmentId, reminderId } = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: new Date(inMin(120)) });
    const reminder = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(60)), reminderId });
    const plain = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(30)) });
    const list = (await app.inject({ method: 'GET', url: '/api/scheduled-messages?status=pending', headers: ana })).json() as ScheduledMessageDto[];
    expect(list.map((r) => [r.id, r.canEdit, r.appointment])).toEqual([
      [plain.id, true, null],
      [reminder.id, false, { id: appointmentId, title: 'Audiência' }],
    ]);

    const bruno = (await loginAs(app, s.agentB.email)).headers;
    const patchIt = (headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: `/api/scheduled-messages/${reminder.id}`, headers, payload: { text: 'x' } });
    const cancelIt = () => app.inject({ method: 'POST', url: `/api/scheduled-messages/${reminder.id}/cancel`, headers: ana });
    expect((await patchIt(bruno)).statusCode).toBe(404);
    for (const res of [await patchIt(ana), await cancelIt()]) expect([res.statusCode, res.json().error]).toEqual([409, REMINDER_LOCKED]);
    // once it went out, the answer is still "change it through the appointment"
    await ctx.db.update(scheduledMessages).set({ status: 'sent' }).where(eq(scheduledMessages.id, reminder.id));
    expect((await cancelIt()).json().error).toBe(REMINDER_LOCKED);
    expect((await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, reminder.id)))[0]!.body).not.toBe('x');
  });
});
```

In `server/test/automation/rules.test.ts`, replace `import { insertScheduled, runningBot } from './seed.js';` with `import { insertAppointment, insertScheduled, runningBot } from './seed.js';`. Then replace

```ts
    expect((await chatRow(priv.chatId)).state).toBe('closed');
    for (const c of [waiting, bot, scheduled]) expect((await chatRow(c.chatId)).state).toBe('open');
  });
```

with

```ts
    expect((await chatRow(priv.chatId)).state).toBe('closed');
    for (const c of [waiting, bot, scheduled]) expect((await chatRow(c.chatId)).state).toBe('open');
  });

  it('a pending appointment reminder does not keep the chat open (spec 2026-10-21 compromissos §3.6, decision 10; Review Focus 5)', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const c = await chat({ at: ago(25 * HOUR) });
    const { reminderId } = await insertAppointment(ctx, { chatId: c.chatId, authorId: s.agentA.id, startsAt: ago(-30 * 24 * HOUR) });
    await insertScheduled(ctx, { chatId: c.chatId, authorId: s.agentA.id, sendAt: ago(-29 * 24 * HOUR), reminderId });
    expect((await run()).closed).toBe(1);
    expect((await chatRow(c.chatId)).state).toBe('closed');
  });
```

In `server/test/automation/delivery.test.ts`, replace

```ts
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

with

```ts
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppointmentDto } from '@talk/shared';
```

and append at the end of the file:

```ts
describe('an appointment reminder (spec 2026-10-21 compromissos §3.6: delivery.ts does not change)', () => {
  const TEXT_AT = (hora: string) => `Olá, Contato! Hoje às ${hora}.`;
  /** Ana's appointment in the chat with one "1 hora antes" reminder, through the route; the caller closes `app`. */
  async function appoint(startsAt: Date, extra: object = {}) {
    const { app } = await makeTestApp(ctx);
    const { headers } = await loginAs(app, s.agentA.email);
    const res = await app.inject({
      method: 'POST', url: '/api/appointments', headers,
      payload: {
        chatId, title: 'Audiência', startsAt: startsAt.toISOString(),
        reminders: [{ amount: 1, unit: 'hours', text: 'Olá, {nome}! Hoje às {hora}.' }], ...extra,
      },
    });
    return { app, headers, appointment: res.json() as AppointmentDto };
  }

  it('goes out at its time as the author, unsigned when the box was off, with the "Agendada" mark', async () => {
    const { app } = await appoint(inMin(65), { signature: false }); // 10:05 in Cuiabá; the reminder at 09:05
    ctx.clock.advance(5 * MIN);
    expect(await beat()).toBe(1);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatchObject({ phone: PHONE, payload: { text: TEXT_AT('10:05') } });
    const [row] = await ctx.db.select().from(scheduledMessages);
    expect(await messageOf(row!.messageId)).toMatchObject({ chatId, authorId: s.agentA.id, scheduled: true });
    await app.close();
  });

  it('in a closed chat, opens a new chat in the original sector like "Nova conversa", signed by default', async () => {
    await closeOriginal();
    const { app } = await appoint(inMin(65));
    ctx.clock.advance(5 * MIN);
    expect(await beat()).toBe(1);
    const [open] = await ctx.db.select().from(chats).where(and(eq(chats.contactId, contactId), eq(chats.state, 'open')));
    expect(open).toMatchObject({ sectorId: s.sectorA, ownerId: s.agentA.id });
    expect(texts()[0]!.payload).toMatchObject({ text: formatSignature(TEXT_AT('10:05'), signatureLabel(s.agentA, 'Financeiro')) });
    await app.close();
  });

  it('a reschedule sends it once, at the new time (Review Focus 1)', async () => {
    const { app, headers, appointment } = await appoint(inMin(65));
    const moved = await app.inject({
      method: 'PATCH', url: `/api/appointments/${appointment.id}`, headers, payload: { startsAt: inMin(75).toISOString() },
    });
    expect(moved.statusCode).toBe(200);
    ctx.clock.advance(5 * MIN); // the old time
    expect(await beat()).toBe(0);
    ctx.clock.advance(10 * MIN); // the new one
    expect(await beat()).toBe(1);
    expect(await beat()).toBe(0);
    expect(texts().map((t) => t.payload)).toMatchObject([{ text: expect.stringContaining(TEXT_AT('10:15')) }]);
    await app.close();
  });
});
```

In `server/test/history/merge.test.ts`, replace

```ts
import {
  chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, deletedChats, messages, scheduledMessages, tags,
} from '../../src/db/schema.js';
```

with

```ts
import {
  appointments, chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, deletedChats, messages,
  scheduledMessages, tags,
} from '../../src/db/schema.js';
import { insertAppointment } from '../automation/seed.js';
```

and add after the test `an absorbed chat's scheduled messages move to the twin (spec 2026-10-20 agendamentos §3.3)`:

```ts
  it("an absorbed chat's appointments move to the twin, with their reminders (spec 2026-10-21 compromissos §3.8; Review Focus 5)", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: phoneId });
    const { reminderId } = await insertAppointment(ctx, { chatId: lidChat, authorId: s.agentA.id, startsAt: new Date() });
    await ctx.db
      .insert(scheduledMessages)
      .values({ chatId: lidChat, authorId: s.agentA.id, body: 'Lembrete', signature: false, sendAt: new Date(), reminderId });

    await mergeLidPairs(ctx, pair);

    expect((await ctx.db.select().from(appointments)).map((a) => a.chatId)).toEqual([phoneChat]);
    expect((await ctx.db.select().from(scheduledMessages)).map((r) => [r.chatId, r.reminderId])).toEqual([[phoneChat, reminderId]]);
  });
```

In `server/test/chats/delete-and-unread.test.ts`, replace

```ts
import { chatEvents, chatPins, chats, contacts, deletedChats, messages, scheduledMessages } from '../../src/db/schema.js';
```

with

```ts
import {
  appointmentReminders, appointments, chatEvents, chatPins, chats, contacts, deletedChats, messages, scheduledMessages,
} from '../../src/db/schema.js';
import { insertAppointment } from '../automation/seed.js';
```

and replace

```ts
    expect(console.info).toHaveBeenCalledWith('chat deleted', { chatId, userId: s.admin.id });
  });
});
```

with

```ts
    expect(console.info).toHaveBeenCalledWith('chat deleted', { chatId, userId: s.admin.id });
  });

  it('deleting the chat removes its appointments, their reminders and their scheduled messages (spec 2026-10-21 compromissos §3.8; Review Focus 5)', async () => {
    // two cascade paths reach the scheduled row: chats → scheduled_messages, and chats → appointments → reminders (set null)
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, phone: PHONE });
    const { reminderId } = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: new Date('2026-10-20T12:00:00Z') });
    await ctx.db.insert(scheduledMessages).values({
      chatId, authorId: s.agentA.id, body: 'Lembrete', signature: true, sendAt: new Date('2026-10-20T11:00:00Z'), reminderId,
    });
    await enableSeeAll(ctx, s.admin);
    const { headers } = await loginAs(app, s.admin.email);
    expect((await app.inject({ method: 'DELETE', url: `/api/chats/${chatId}`, headers })).statusCode).toBe(204);
    expect(await ctx.db.select().from(appointments)).toEqual([]);
    expect(await ctx.db.select().from(appointmentReminders)).toEqual([]);
    expect(await ctx.db.select().from(scheduledMessages)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/automation/scheduled-api.test.ts test/automation/rules.test.ts test/automation/delivery.test.ts test/history/merge.test.ts test/chats/delete-and-unread.test.ts`
Expected: FAIL, in three tests:
- the Agenda test: `REMINDER_LOCKED` is undefined, `appointment` is missing from the DTO, and the reminder's `canEdit` is true;
- the rules test: it closes 0 chats;
- the merge test: `[]` (the cascade deleted the appointment) and `[[phoneChat, null]]`.

The three delivery tests and the delete test PASS already. They are guards (see the task's opening note).

- [ ] **Step 3: Guard and mark reminders in the Agenda**

In `server/src/automation/scheduled.ts`, replace

```ts
import { chats, contacts, messages, scheduledMessages, users } from '../db/schema.js';
```

with

```ts
import { appointmentReminders, appointments, chats, contacts, messages, scheduledMessages, users } from '../db/schema.js';
```

replace

```ts
export const NOT_PENDING = 'Esta mensagem agendada não está mais pendente';
```

with

```ts
export const NOT_PENDING = 'Esta mensagem agendada não está mais pendente';
/** Spec 2026-10-21 compromissos §3.7 (decision 4): the appointment is the only source of a reminder's time and text. */
export const REMINDER_LOCKED = 'Este lembrete é de um compromisso; altere pelo compromisso';
```

replace

```ts
    .select({
      s: scheduledMessages, contactId: contacts.id, contactName: contacts.name, contactPhone: contacts.phone,
      authorName: users.name, sentChatId: messages.chatId,
    })
    .from(scheduledMessages)
    .innerJoin(chats, eq(chats.id, scheduledMessages.chatId))
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(users, eq(users.id, scheduledMessages.authorId))
    .leftJoin(messages, eq(messages.id, scheduledMessages.messageId))
```

with

```ts
    .select({
      s: scheduledMessages, contactId: contacts.id, contactName: contacts.name, contactPhone: contacts.phone,
      authorName: users.name, sentChatId: messages.chatId, appointmentId: appointments.id, appointmentTitle: appointments.title,
    })
    .from(scheduledMessages)
    .innerJoin(chats, eq(chats.id, scheduledMessages.chatId))
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(users, eq(users.id, scheduledMessages.authorId))
    .leftJoin(messages, eq(messages.id, scheduledMessages.messageId))
    // spec 2026-10-21 compromissos §3.7: a reminder's appointment, for the "Lembrete · <título>" mark
    .leftJoin(appointmentReminders, eq(appointmentReminders.id, scheduledMessages.reminderId))
    .leftJoin(appointments, eq(appointments.id, appointmentReminders.appointmentId))
```

replace

```ts
    canEdit: s.status === 'pending' && canManage(user, s),
  }));
```

with

```ts
    canEdit: s.status === 'pending' && !s.reminderId && canManage(user, s),
    appointment: r.appointmentId ? { id: r.appointmentId, title: r.appointmentTitle ?? '' } : null,
  }));
```

and replace

```ts
  if (!row || !canManage(user, row)) throw notFound();
  if (row.status !== 'pending') throw conflict(NOT_PENDING);
```

with

```ts
  if (!row || !canManage(user, row)) throw notFound();
  if (row.reminderId) throw conflict(REMINDER_LOCKED); // before "not pending": a reminder never changes here
  if (row.status !== 'pending') throw conflict(NOT_PENDING);
```

- [ ] **Step 4: Let "Finalizar por inatividade" ignore reminders**

In `server/src/automation/rules.ts`, replace

```ts
import { and, asc, eq, gte, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
```

with

```ts
import { and, asc, eq, gte, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
```

and replace

```ts
        notExists(
          ctx.db
            .select({ one })
            .from(scheduledMessages)
            .where(and(eq(scheduledMessages.chatId, chats.id), inArray(scheduledMessages.status, OPEN_STATUSES))),
        ),
```

with

```ts
        // a pending scheduled message keeps the chat open; an appointment's reminder does not (spec 2026-10-21 compromissos
        // §3.6, decision 10): it may be 30 days away, and its send opens a new chat in the original sector anyway
        notExists(
          ctx.db
            .select({ one })
            .from(scheduledMessages)
            .where(
              and(eq(scheduledMessages.chatId, chats.id), inArray(scheduledMessages.status, OPEN_STATUSES), isNull(scheduledMessages.reminderId)),
            ),
        ),
```

- [ ] **Step 5: Keep appointments through a LID merge**

In `server/src/history/merge.ts`, replace

```ts
import {
  botRuns, chatEvents, chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, deletedChats, messages,
  scheduledMessages,
} from '../db/schema.js';
```

with

```ts
import {
  appointments, botRuns, chatEvents, chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, deletedChats, messages,
  scheduledMessages,
} from '../db/schema.js';
```

and replace

```ts
  await tx.update(scheduledMessages).set({ chatId: twin.id }).where(eq(scheduledMessages.chatId, from.id));
```

with

```ts
  await tx.update(scheduledMessages).set({ chatId: twin.id }).where(eq(scheduledMessages.chatId, from.id));
  // spec 2026-10-21 compromissos §3.8: so do appointments, with their reminders; a chat that only changes contact needs
  // nothing, because an appointment takes its contact from the chat
  await tx.update(appointments).set({ chatId: twin.id }).where(eq(appointments.chatId, from.id));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server`
Expected: PASS (the whole server suite: the scheduled-message, rules, delivery, merge and delete suites included).

Run: `npm run typecheck -w server` and `git diff af9b84e -- server/src/automation/delivery.ts`
Expected: no errors, and an empty diff.

- [ ] **Step 7: Commit**

```bash
git add server/src/automation/scheduled.ts server/src/automation/rules.ts server/src/history/merge.ts server/test/automation/scheduled-api.test.ts server/test/automation/rules.test.ts server/test/automation/delivery.test.ts server/test/history/merge.test.ts server/test/chats/delete-and-unread.test.ts
git commit -m "feat(server): reminders are locked and marked in the Agenda, ignored by the inactivity rule, kept by the LID merge" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Default reminders setting (API)

**Files:**
- Modify: `server/src/catalog/settings.ts` (import, `getAppointmentReminders`, two routes)
- Test: `server/test/catalog/settings.test.ts`

**Interfaces:**
- Consumes: Task 1 `DEFAULT_APPOINTMENT_REMINDERS`, `remindersProblem`, `AppointmentRemindersDto`; Task 2 `reminderList`.
- Produces: `getAppointmentReminders(db)`, `GET` / `PUT /api/settings/appointment-reminders` (decision 5: GET for everyone, PUT admin only).

- [ ] **Step 1: Write the failing test**

In `server/test/catalog/settings.test.ts`, replace

```ts
import { DEFAULT_AUTO_RULES } from '@talk/shared';
import { getAutoRules, getBotRunningBehavior } from '../../src/catalog/settings.js';
```

with

```ts
import { DEFAULT_APPOINTMENT_REMINDERS, DEFAULT_AUTO_RULES } from '@talk/shared';
import { getAppointmentReminders, getAutoRules, getBotRunningBehavior } from '../../src/catalog/settings.js';
```

and append at the end of the file:

```ts
it('appointment reminders: the defaults for everyone, saved by an admin only, validated (spec 2026-10-21 compromissos §4)', async () => {
  const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/settings/appointment-reminders', headers });
  const putReminders = (headers: Record<string, string>, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/settings/appointment-reminders', headers, payload });
  const mine = { reminders: [{ amount: 3, unit: 'days', text: 'Olá, {nome}! {titulo} em {data}.' }] };

  expect((await get(agent)).json()).toEqual(DEFAULT_APPOINTMENT_REMINDERS); // the form of every agent starts with them
  expect((await putReminders(agent, mine)).statusCode).toBe(403);
  expect((await putReminders({ cookie: admin.cookie! }, mine)).statusCode).toBe(403); // no Origin

  const saved = await putReminders(admin, { reminders: [{ ...mine.reminders[0], text: '  Olá, {nome}! {titulo} em {data}.  ' }] });
  expect([saved.statusCode, saved.json()]).toEqual([200, mine]);
  expect((await get(agent)).json()).toEqual(mine);

  const unknown = await putReminders(admin, { reminders: [{ amount: 1, unit: 'hours', text: 'Olá, {Nome}!' }] });
  expect([unknown.statusCode, unknown.json().error]).toEqual([400, 'Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}']);
  const sameTime = await putReminders(admin, { reminders: [{ amount: 2, unit: 'days', text: 'a' }, { amount: 48, unit: 'hours', text: 'b' }] });
  expect([sameTime.statusCode, sameTime.json().error]).toEqual([400, 'Dois lembretes cairiam no mesmo horário']);
  for (const bad of [
    { reminders: [] },
    { reminders: Array.from({ length: 6 }, (_, i) => ({ amount: i + 1, unit: 'hours', text: 'a' })) },
    { reminders: [{ amount: 0, unit: 'days', text: 'a' }] },
    { reminders: [{ amount: 31, unit: 'days', text: 'a' }] },
    { reminders: [{ amount: 49, unit: 'hours', text: 'a' }] },
    { reminders: [{ amount: 1.5, unit: 'hours', text: 'a' }] },
    { reminders: [{ amount: 1, unit: 'hours', text: '  ' }] },
    {},
  ]) {
    expect((await putReminders(admin, bad)).statusCode).toBe(400);
  }
  expect(await getAppointmentReminders(ctx.db)).toEqual(mine);

  // a broken stored value reads as the defaults
  await ctx.db.update(settings).set({ value: { reminders: 'sim' } }).where(eq(settings.key, 'appointment_reminders'));
  expect(await getAppointmentReminders(ctx.db)).toEqual(DEFAULT_APPOINTMENT_REMINDERS);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: FAIL. `getAppointmentReminders` is not exported, and the GET answers 404.

- [ ] **Step 3: Read, validate and store the defaults**

In `server/src/catalog/settings.ts`, replace

```ts
import {
  APPOINTMENT_LIMITS, CLOSE_INACTIVE_HOURS, DEFAULT_AUTO_RULES, REMINDER_UNITS, RETURN_TO_QUEUE_MINUTES, SCHEDULE_TEXT_MAX,
  type AutoRulesDto, type BotRunningBehavior, type SettingsDto,
} from '@talk/shared';
```

with

```ts
import {
  APPOINTMENT_LIMITS, CLOSE_INACTIVE_HOURS, DEFAULT_APPOINTMENT_REMINDERS, DEFAULT_AUTO_RULES, REMINDER_UNITS, RETURN_TO_QUEUE_MINUTES,
  SCHEDULE_TEXT_MAX, remindersProblem, type AppointmentRemindersDto, type AutoRulesDto, type BotRunningBehavior, type SettingsDto,
} from '@talk/shared';
```

replace

```ts
  .min(1)
  .max(APPOINTMENT_LIMITS.remindersMax);
```

with

```ts
  .min(1)
  .max(APPOINTMENT_LIMITS.remindersMax);

const AppointmentRemindersBody = z.object({ reminders: reminderList });

/** settings 'appointment_reminders' (spec 2026-10-21 compromissos §4); the defaults when the key is missing or invalid. */
export async function getAppointmentReminders(db: Db | Tx): Promise<AppointmentRemindersDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'appointment_reminders'));
  const parsed = AppointmentRemindersBody.safeParse(row?.value);
  return parsed.success && !remindersProblem(parsed.data.reminders, null) ? parsed.data : DEFAULT_APPOINTMENT_REMINDERS;
}
```

and replace

```ts
    return getAutoRules(ctx.db);
  });

  app.put('/api/settings', async (req) => {
```

with

```ts
    return getAutoRules(ctx.db);
  });

  // Spec 2026-10-21 compromissos §4 (decision 5): every user reads them (the form starts with them); only an admin saves them.
  // Changing them never changes saved appointments: each reminder keeps its own copy of the text.
  app.get('/api/settings/appointment-reminders', async () => getAppointmentReminders(ctx.db));

  app.put('/api/settings/appointment-reminders', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const value = AppointmentRemindersBody.parse(req.body);
    const problem = remindersProblem(value.reminders, null); // no contact here: {nome} is fine
    if (problem) throw badRequest(problem);
    await ctx.db
      .insert(settings)
      .values({ key: 'appointment_reminders', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    return getAppointmentReminders(ctx.db);
  });

  app.put('/api/settings', async (req) => {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: PASS.

Run: `npm test -w server` and `npm run typecheck -w server`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/catalog/settings.ts server/test/catalog/settings.test.ts
git commit -m "feat(server): default appointment reminders setting (GET for everyone, PUT for admins)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web client, and the "Lembrete · <título>" mark

The web code follows the "Mensageiro" look and its `ui.ts` recipes. The mark takes the place of Editar / Cancelar, which a reminder never has (`canEdit` false). It links to the Agenda's Compromissos tab (decision 1).

**Files:**
- Modify: `web/src/lib/api.ts` (type imports, input types, `api.settings`, `api.appointments`, `qk`)
- Modify: `web/src/components/conversation/Scheduled.tsx` (`ScheduledItem`)
- Test: `web/src/lib/api.test.ts`, `web/src/components/conversation/Scheduled.test.tsx`

**Interfaces:**
- Consumes: Task 1 `AppointmentDto`, `AppointmentRemindersDto`, `AppointmentTab`, `ReminderInput`, `ScheduledMessageDto.appointment`; the routes of Tasks 2, 3 and 5.
- Produces:
  - types `AppointmentInput`, `AppointmentPatch`;
  - calls `api.appointments.{listForChat, list, create, update, cancel}`, `api.settings.appointmentReminders.{get, put}`;
  - query keys `qk.appointments`, `qk.chatAppointments`, `qk.appointmentList`, `qk.appointmentReminders`;
  - the mark in `ScheduledItem`.

- [ ] **Step 1: Write the failing tests**

In `web/src/lib/api.test.ts`, replace

```ts
import { DEFAULT_AUTO_RULES } from '@talk/shared';
```

with

```ts
import { DEFAULT_APPOINTMENT_REMINDERS, DEFAULT_AUTO_RULES } from '@talk/shared';
```

and append at the end of the file:

```ts
describe('api routes of the 2026-10-21 compromissos delivery', () => {
  it('calls the appointment and default-reminder routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const { reminders } = DEFAULT_APPOINTMENT_REMINDERS;
    const input = { contactId: 'k1', title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', signature: false, reminders };
    await api.appointments.listForChat('c1');
    await api.appointments.list('past');
    await api.appointments.create(input);
    await api.appointments.update('a1', { note: null });
    await api.appointments.cancel('a1');
    await api.settings.appointmentReminders.get();
    await api.settings.appointmentReminders.put({ reminders });
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)} ${String(i?.body ?? '')}`)).toEqual([
      'GET /api/chats/c1/appointments ',
      'GET /api/appointments?tab=past ',
      `POST /api/appointments ${JSON.stringify(input)}`,
      'PATCH /api/appointments/a1 {"note":null}',
      'POST /api/appointments/a1/cancel ',
      'GET /api/settings/appointment-reminders ',
      `PUT /api/settings/appointment-reminders ${JSON.stringify({ reminders })}`,
    ]);
  });
});
```

In `web/src/components/conversation/Scheduled.test.tsx`, replace

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
```

with

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
```

replace

```tsx
  render(
    <QueryClientProvider client={qc}>
      <ScheduledStrip chatId="c1" />
    </QueryClientProvider>,
  );
```

with

```tsx
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScheduledStrip chatId="c1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
```

and add inside `describe('ScheduledStrip (spec §3.2)', …)`, after the test `shows nothing without pending messages`:

```tsx
  it('marks an appointment reminder "Lembrete · <título>" in place of Editar/Cancelar (spec 2026-10-21 compromissos §3.7)', async () => {
    stubFetch({ 'GET /api/chats/c1/scheduled-messages': [item({ canEdit: false, appointment: { id: 'a1', title: 'Audiência' } })] });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '1 mensagem agendada' }));
    expect(screen.getByRole('link', { name: 'Lembrete · Audiência' }).getAttribute('href')).toBe('/agendamentos?aba=compromissos');
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/lib/api.test.ts src/components/conversation/Scheduled.test.tsx`
Expected: FAIL. `api.appointments` is undefined, and there is no "Lembrete · Audiência" link.

- [ ] **Step 3: Add the client calls and the query keys**

In `web/src/lib/api.ts`, replace

```ts
import type {
  AutoRulesDto,
  BotAction,
```

with

```ts
import type {
  AppointmentDto,
  AppointmentRemindersDto,
  AppointmentTab,
  AutoRulesDto,
  BotAction,
```

replace

```ts
  RecentStickerDto,
  SaveVersionInput,
```

with

```ts
  RecentStickerDto,
  ReminderInput,
  SaveVersionInput,
```

replace

```ts
export interface ScheduleInput { text: string; sendAt: string; signature: boolean; file?: Blob; fileName?: string }
```

with

```ts
export interface ScheduleInput { text: string; sendAt: string; signature: boolean; file?: Blob; fileName?: string }
/** Spec 2026-10-21 compromissos §5.3: exactly one of chatId / contactId; startsAt is an ISO instant. */
export interface AppointmentInput {
  chatId?: string; contactId?: string; title: string; startsAt: string; note?: string; signature: boolean; reminders: ReminderInput[];
}
/** At least one field; note null clears it. */
export interface AppointmentPatch { title?: string; startsAt?: string; note?: string | null }
```

replace

```ts
    autoRules: {
      get: () => request<AutoRulesDto>('GET', '/api/settings/auto-rules'),
      put: (rules: AutoRulesDto) => request<AutoRulesDto>('PUT', '/api/settings/auto-rules', rules),
    },
  },
```

with

```ts
    autoRules: {
      get: () => request<AutoRulesDto>('GET', '/api/settings/auto-rules'),
      put: (rules: AutoRulesDto) => request<AutoRulesDto>('PUT', '/api/settings/auto-rules', rules),
    },
    /** Spec 2026-10-21 compromissos §4: every user reads them (the form starts with them); an admin saves them. */
    appointmentReminders: {
      get: () => request<AppointmentRemindersDto>('GET', '/api/settings/appointment-reminders'),
      put: (value: AppointmentRemindersDto) => request<AppointmentRemindersDto>('PUT', '/api/settings/appointment-reminders', value),
    },
  },
```

replace

```ts
    cancel: (id: string) => request<ScheduledMessageDto>('POST', `/api/scheduled-messages/${enc(id)}/cancel`),
  },
  channels: {
```

with

```ts
    cancel: (id: string) => request<ScheduledMessageDto>('POST', `/api/scheduled-messages/${enc(id)}/cancel`),
  },
  appointments: {
    /** The contact's upcoming ones, in every chat of theirs the user sees (spec 2026-10-21 compromissos §3.4). */
    listForChat: (chatId: string) => request<AppointmentDto[]>('GET', `/api/chats/${enc(chatId)}/appointments`),
    /** Mine (an admin: everyone's), one tab at a time (§3.5). */
    list: (tab: AppointmentTab) => request<AppointmentDto[]>('GET', `/api/appointments${qs({ tab })}`),
    create: (input: AppointmentInput) => request<AppointmentDto>('POST', '/api/appointments', input),
    update: (id: string, patch: AppointmentPatch) => request<AppointmentDto>('PATCH', `/api/appointments/${enc(id)}`, patch),
    cancel: (id: string) => request<AppointmentDto>('POST', `/api/appointments/${enc(id)}/cancel`),
  },
  channels: {
```

and replace

```ts
  scheduledList: (tab: ScheduledTab) => ['chats', 'scheduled', 'list', tab] as const,
```

with

```ts
  scheduledList: (tab: ScheduledTab) => ['chats', 'scheduled', 'list', tab] as const,
  /** Every appointment list (prefix), under ['chats'] like the scheduled ones (spec 2026-10-21 compromissos). */
  appointments: ['chats', 'appointments'] as const,
  chatAppointments: (chatId: string) => ['chats', 'appointments', 'chat', chatId] as const,
  appointmentList: (tab: AppointmentTab) => ['chats', 'appointments', 'list', tab] as const,
  appointmentReminders: ['settings', 'appointment-reminders'] as const,
```

- [ ] **Step 4: The mark**

In `web/src/components/conversation/Scheduled.tsx`, replace

```tsx
        </span>
      )}
      {editing && (
```

with

```tsx
        </span>
      )}
      {item.appointment && (
        // spec 2026-10-21 compromissos §3.7: a reminder changes only through its appointment, so the mark takes Editar/Cancelar's place
        <Link to="/agendamentos?aba=compromissos" className={`${badge} ${badgeTone.accent} hover:underline`}>
          Lembrete · {item.appointment.title}
        </Link>
      )}
      {editing && (
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w web -- src/lib/api.test.ts src/components/conversation/Scheduled.test.tsx src/pages/ScheduledMessages.test.tsx`
Expected: PASS.

Run: `npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/components/conversation/Scheduled.tsx web/src/components/conversation/Scheduled.test.tsx
git commit -m "feat(web): appointment client calls and the Lembrete mark on scheduled reminders" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The appointment form, the chat's "Compromissos" button and dialog

The form and the lists follow the scheduled-message dialog (`ScheduleDialog` / `ScheduledItem`): `Modal` + `Actions`, `fieldLabel` + `field` / `fieldArea` / `fieldSelect`, the `checkbox` recipe, `badge` tones, `confirmDialog`. Each reminder line sits in a sunken block with `role="group"`, named "Lembrete N". The lead amount is a `<select>` of the allowed numbers (decision 10). "Não será enviado" is a warning (`text-warning`), not an error.

**Files:**
- Create: `web/src/components/conversation/Appointments.tsx`
- Modify: `web/src/components/conversation/ChatDialogs.tsx` (`Modal`)
- Modify: `web/src/components/conversation/ConversationHeader.tsx` (import, state, button, dialog)
- Modify: `web/src/components/conversation/ConversationView.tsx` (the `chat.updated` handler)
- Test: `web/src/components/conversation/Appointments.test.tsx` (create), `web/src/components/conversation/ConversationHeader.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1: `appointmentTimeProblem`, `reminderSendAt`, `reminderTextProblem`, `remindersProblem`, `fillReminderText`, `APPOINTMENT_LIMITS`, `REMINDER_UNITS`;
  - Task 6: `api.appointments`, `api.settings.appointmentReminders`, `qk.*`;
  - existing: `api.contacts.list`, `Modal`, `Actions`, `confirmDialog`, `contactLabel`, `errorMessage`.
- Produces:
  - `reminderLead`, `reminderStatus`, `ReminderSample`, `ReminderRows` (used by Task 9);
  - `AppointmentDialog`, `AppointmentItem` (used by Task 8);
  - `ChatAppointmentsDialog`, and the header button "Compromissos".

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/conversation/Appointments.test.tsx`:

```tsx
// @vitest-environment jsdom
// Review Focus 2: the form must read the time as Cuiabá time whatever the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto } from '@talk/shared';
import { confirmDialog } from '../../lib/confirm';
import { AppointmentDialog, ChatAppointmentsDialog } from './Appointments';

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
      const path = `${url.pathname}${url.search}`;
      calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const key = `${method} ${path}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const appointment = (over: Partial<AppointmentDto> = {}): AppointmentDto => ({
  id: 'a1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
  title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', note: 'Levar RG', canceledAt: null, canceledByName: null,
  createdAt: '2026-10-20T12:00:00.000Z', canEdit: true,
  reminders: [
    { id: 'r1', amount: 2, unit: 'days', text: 'Olá', sendAt: '2026-10-19T18:00:00.000Z', status: 'skipped', scheduledId: null, error: null },
    { id: 'r2', amount: 1, unit: 'hours', text: 'Olá', sendAt: '2026-10-21T17:00:00.000Z', status: 'pending', scheduledId: 's2', error: null },
  ],
  ...over,
});
const CHAT = { id: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999', avatarUrl: null } };

function renderUi(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const when = () => screen.getByLabelText('Data e hora (horário de Cuiabá)') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
const alertText = () => screen.getByRole('alert').textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z')); // 08:00 in Cuiabá, 21:00 in Tokyo (the host here)
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(confirmDialog).mockClear();
});

describe('AppointmentDialog (spec 2026-10-21 compromissos §3.1–3.3)', () => {
  it('starts with the default reminders, reads the time as Cuiabá time, warns live and previews the text (Review Focus 2)', async () => {
    stubFetch({ 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS, 'POST /api/appointments': appointment() });
    const onClose = vi.fn();
    renderUi(<AppointmentDialog chatId="c1" contactName="Maria Cliente" onClose={onClose} />);
    const first = await screen.findByRole('group', { name: 'Lembrete 1' });
    const second = screen.getByRole('group', { name: 'Lembrete 2' });
    expect((within(first).getByLabelText('Texto do lembrete') as HTMLTextAreaElement).value).toBe(DEFAULT_APPOINTMENT_REMINDERS.reminders[0]!.text);
    expect((within(first).getByLabelText('Antecedência') as HTMLSelectElement).options).toHaveLength(30); // 1–30 days
    expect((within(second).getByLabelText('Antecedência') as HTMLSelectElement).options).toHaveLength(48); // 1–48 hours
    expect(within(second).getByText('Marcadores: {nome}, {titulo}, {data}, {hora}')).toBeTruthy();
    expect(screen.queryByLabelText('Cliente')).toBeNull();
    // the host clock reads 21:00, so a form that used the host zone would offer 21:00 here
    expect(when().min).toBe('2026-10-20T08:00');

    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Audiência' } });
    // 21/10 14:00 in Cuiabá: "2 dias antes" (19/10 14:00) already passed
    fireEvent.change(when(), { target: { value: '2026-10-21T14:00' } });
    expect(within(first).getByText('Não será enviado: o horário de envio já passou')).toBeTruthy();
    expect(within(second).queryByText('Não será enviado: o horário de envio já passou')).toBeNull();
    expect(
      within(second).getByText('Vai sair assim: Olá, Maria Cliente! Seu compromisso (Audiência) é às 14:00 de 21/10/2026 (horário de Cuiabá).'),
    ).toBeTruthy();

    const signature = screen.getByLabelText('Enviar com minha assinatura') as HTMLInputElement;
    expect(signature.checked).toBe(true);
    fireEvent.click(signature);
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      chatId: 'c1', title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', signature: false, reminders: DEFAULT_APPOINTMENT_REMINDERS.reminders,
    });
  });

  it('says what is missing: title, time, a past time, {nome} without a name, an unknown placeholder, two reminders at once, none', async () => {
    stubFetch({ 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
    renderUi(<AppointmentDialog chatId="c1" contactName={null} onClose={() => {}} />);
    await screen.findByRole('group', { name: 'Lembrete 1' });
    save();
    expect(alertText()).toBe('Digite o título');
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Audiência' } });
    save();
    expect(alertText()).toBe('Escolha a data e a hora');
    fireEvent.change(when(), { target: { value: '2026-10-20T08:00' } });
    save();
    expect(alertText()).toBe('Este horário já passou; escolha uma data e hora futuras');
    fireEvent.change(when(), { target: { value: '2026-10-25T14:00' } });
    save();
    expect(alertText()).toBe('O contato não tem nome cadastrado; tire {nome} do lembrete'); // the defaults greet {nome}

    const [first, second] = screen.getAllByRole('group');
    fireEvent.change(within(first!).getByLabelText('Texto do lembrete'), { target: { value: 'Oi, {Nome}!' } });
    expect(within(first!).getByText('Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}')).toBeTruthy(); // live
    fireEvent.change(within(first!).getByLabelText('Texto do lembrete'), { target: { value: 'Faltam dois dias.' } });
    fireEvent.change(within(second!).getByLabelText('Texto do lembrete'), { target: { value: 'Hoje às {hora}.' } });
    fireEvent.change(within(second!).getByLabelText('Antecedência'), { target: { value: '48' } }); // 48 hours = 2 days
    save();
    expect(alertText()).toBe('Dois lembretes cairiam no mesmo horário');

    fireEvent.click(within(second!).getByRole('button', { name: 'Remover' }));
    fireEvent.click(within(first!).getByRole('button', { name: 'Remover' }));
    save();
    expect(alertText()).toBe('Inclua pelo menos um lembrete');
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar lembrete' }));
    save();
    expect(alertText()).toBe('Digite o texto do lembrete');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('from the Agenda: "Cliente" searches contacts from 2 letters and sends the contactId', async () => {
    stubFetch({
      'GET /api/settings/appointment-reminders': { reminders: [{ amount: 1, unit: 'hours', text: 'Olá, {nome}!' }] },
      'GET /api/contacts?q=Ma&limit=8': { items: [{ id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }], nextCursor: null },
      'POST /api/appointments': appointment(),
    });
    const onClose = vi.fn();
    renderUi(<AppointmentDialog onClose={onClose} />);
    const client = await screen.findByLabelText('Cliente');
    expect(client.getAttribute('placeholder')).toBe('Nome ou telefone');
    fireEvent.change(client, { target: { value: 'M' } });
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Retorno de documento' } });
    fireEvent.change(when(), { target: { value: '2026-10-25T14:00' } });
    save();
    expect(alertText()).toBe('Escolha o cliente');

    fireEvent.change(client, { target: { value: 'Ma' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Maria Cliente · +55 65 99999-9999' }));
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      contactId: 'k1', title: 'Retorno de documento', startsAt: '2026-10-25T18:00:00.000Z', signature: true,
    });
    expect(calls.some((c) => c.path === '/api/contacts?q=M&limit=8')).toBe(false); // one letter: no search
  });

  it('edits title, time and note only, shows the reminders read-only, does not check a kept time again and sends only what changed', async () => {
    stubFetch({ 'PATCH /api/appointments/a1': appointment({ note: null }) });
    const onClose = vi.fn();
    // 19/10 14:00 in Cuiabá: already past now
    renderUi(<AppointmentDialog appointment={appointment({ startsAt: '2026-10-19T18:00:00.000Z' })} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Editar compromisso' })).toBeTruthy();
    expect(when().value).toBe('2026-10-19T14:00');
    expect(screen.getByText('2 dias antes')).toBeTruthy();
    expect(screen.getByText('Não criado: o horário de envio já tinha passado')).toBeTruthy();
    expect(screen.getByText('1 hora antes')).toBeTruthy();
    expect(screen.getByText('Pendente · 21/10/2026 13:00')).toBeTruthy();
    expect(screen.queryByLabelText('Texto do lembrete')).toBeNull();
    expect(screen.queryByLabelText('Enviar com minha assinatura')).toBeNull();

    fireEvent.change(screen.getByLabelText('Observação interna (não é enviada ao cliente)'), { target: { value: '' } });
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([['PATCH', '/api/appointments/a1', { note: null }]]);
  });
});

describe('ChatAppointmentsDialog (spec §3.4)', () => {
  it('lists the contact’s upcoming appointments, with Editar/Cancelar only where allowed, and cancels after confirming', async () => {
    stubFetch({
      'GET /api/chats/c1/appointments': [appointment(), appointment({ id: 'a2', title: 'Perícia', authorName: 'Bruno', note: null, canEdit: false })],
      'POST /api/appointments/a1/cancel': appointment({ canceledAt: '2026-10-20T12:00:00.000Z', canEdit: false }),
    });
    renderUi(<ChatAppointmentsDialog chat={CHAT} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Compromissos de Maria Cliente' });
    expect(await within(dialog).findByText('Perícia')).toBeTruthy();
    expect(within(dialog).getByText('por Bruno')).toBeTruthy();
    expect(within(dialog).getByText('Observação interna')).toBeTruthy();
    expect(within(dialog).getByText('Levar RG')).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: 'Editar' })).toHaveLength(1);
    expect(within(dialog).getByRole('link', { name: 'Ver todos os compromissos' }).getAttribute('href')).toBe('/agendamentos?aba=compromissos');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/appointments/a1/cancel')).toBe(true));
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Cancelar o compromisso?', body: 'Os lembretes que ainda não saíram não serão enviados.',
      confirmLabel: 'Cancelar compromisso', cancelLabel: 'Manter compromisso',
    });
  });

  it('says so when there is none, and "Novo compromisso" opens the form for this chat', async () => {
    stubFetch({ 'GET /api/chats/c1/appointments': [], 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
    renderUi(<ChatAppointmentsDialog chat={CHAT} onClose={() => {}} />);
    expect(await screen.findByText('Nenhum compromisso marcado com este cliente.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Novo compromisso' }));
    expect(await screen.findByRole('dialog', { name: 'Novo compromisso' })).toBeTruthy();
    expect(await screen.findByRole('group', { name: 'Lembrete 1' })).toBeTruthy();
  });
});
```

In `web/src/components/conversation/ConversationHeader.test.tsx`, replace

```tsx
      if (method === 'GET' && url.pathname === '/api/users') return json(200, []);
```

with

```tsx
      if (method === 'GET' && url.pathname === '/api/users') return json(200, []);
      if (method === 'GET' && url.pathname === '/api/chats/c1/appointments') return json(200, []);
```

and append at the end of the file:

```tsx
describe('ConversationHeader appointments (spec 2026-10-21 compromissos §3.1)', () => {
  it('"Compromissos" opens the contact’s appointments, also in a closed chat', async () => {
    stubFetch();
    renderHeader({ ...CHAT, state: 'closed' });
    fireEvent.click(screen.getByRole('button', { name: 'Compromissos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compromissos de Maria' });
    expect(await within(dialog).findByText('Nenhum compromisso marcado com este cliente.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/Appointments.test.tsx src/components/conversation/ConversationHeader.test.tsx`
Expected: FAIL. `./Appointments` does not exist, and there is no "Compromissos" button.

- [ ] **Step 3: Let a dialog opened over another close alone**

In `web/src/components/conversation/ChatDialogs.tsx`, replace

```tsx
      onCancel={(e) => {
        e.preventDefault(); // Esc: let React unmount it
        onCancel();
      }}
```

with

```tsx
      onCancel={(e) => {
        e.preventDefault(); // Esc: let React unmount it
        e.stopPropagation(); // a dialog opened over another (Compromissos → Novo compromisso) closes alone
        onCancel();
      }}
```

- [ ] **Step 4: Write the components**

Create `web/src/components/conversation/Appointments.tsx`:

```tsx
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from '@phosphor-icons/react';
import {
  APPOINTMENT_LIMITS, REMINDER_UNITS, SCHEDULE_MAX_AHEAD_MS, SCHEDULE_TEXT_MAX, appointmentTimeProblem, fillReminderText,
  formatOfficeDateTime, isoToOfficeLocal, officeLocalToIso, reminderSendAt, reminderTextProblem, remindersProblem,
  scheduleTimeProblem, type AppointmentDto, type AppointmentReminderDto, type ChatDetail, type ContactDto, type ReminderInput,
  type ReminderUnit,
} from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { contactLabel } from '../../lib/format';
import {
  badge, badgeTone, button, checkbox, field, fieldArea, fieldError, fieldHint, fieldLabel, fieldSelect, menuItem,
} from '../ui';
import { Actions, Modal } from './ChatDialogs';
import { errorMessage } from './model';

// "Não será enviado": a warning about one line, not an error of the form
const warning = 'mt-1.5 text-xs leading-4 font-semibold text-warning';
const UNIT_LABELS: Record<ReminderUnit, string> = { days: 'dias antes', hours: 'horas antes' };
/** decision 10: the lead amount is a list of the allowed numbers, so it is never out of range */
function amountsOf(unit: ReminderUnit): number[] {
  const { min, max } = APPOINTMENT_LIMITS[unit];
  return Array.from({ length: max - min + 1 }, (_, k) => min + k);
}

/** "2 dias antes", "1 hora antes" (spec 2026-10-21 compromissos §6). */
export function reminderLead(r: { amount: number; unit: ReminderUnit }): string {
  const word = r.unit === 'days' ? (r.amount === 1 ? 'dia' : 'dias') : r.amount === 1 ? 'hora' : 'horas';
  return `${r.amount} ${word} antes`;
}

/** A reminder's situation (spec §6). */
export function reminderStatus(r: AppointmentReminderDto): string {
  switch (r.status) {
    case 'pending':
      return `Pendente · ${formatOfficeDateTime(r.sendAt)}`;
    case 'sending':
      return 'Enviando…';
    case 'sent':
      return 'Enviado';
    case 'failed':
      return `Falhou: ${r.error ?? ''}`;
    case 'canceled':
      return 'Cancelado';
    case 'skipped':
      return 'Não criado: o horário de envio já tinha passado';
  }
}

/** The appointment lists and the scheduled-message lists (a reminder is one): both under ['chats']. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: qk.appointments }), qc.invalidateQueries({ queryKey: qk.scheduled })]);
}

/** The values "Vai sair assim" fills in. */
export interface ReminderSample { nome: string; titulo: string; startsAt: string }

/**
 * The reminder lines of the form and of Configurações → Compromissos (spec §3.2, §4): lead time, text, the placeholders,
 * the problem of the line or "Vai sair assim". With `startsAt` (the form), a line whose send time passed says "Não será enviado".
 */
export function ReminderRows(props: {
  reminders: ReminderInput[];
  onChange: (next: ReminderInput[]) => void;
  /** null: no preview yet (no date). */
  sample: ReminderSample | null;
  /** The contact's name for {nome}; undefined where there is no contact (Configurações). */
  contactName?: string | null;
  startsAt?: Date | null;
}) {
  const { reminders, onChange } = props;
  const set = (i: number, patch: Partial<ReminderInput>) => onChange(reminders.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const now = new Date();
  return (
    <div className="flex flex-col gap-3">
      {reminders.map((r, i) => {
        const problem = reminderTextProblem(r.text, props.contactName);
        const late = !!props.startsAt && !!scheduleTimeProblem(reminderSendAt(props.startsAt, r.amount, r.unit), now);
        return (
          // key: the position; every value lives in `reminders`, so removing a line shifts nothing stale
          <div key={i} role="group" aria-label={`Lembrete ${i + 1}`} className="rounded-block bg-sunken p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-24">
                <select
                  aria-label="Antecedência"
                  value={r.amount}
                  onChange={(e) => set(i, { amount: Number(e.target.value) })}
                  className={fieldSelect}
                >
                  {amountsOf(r.unit).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-40">
                <select
                  aria-label="Unidade"
                  value={r.unit}
                  onChange={(e) => {
                    const unit = e.target.value as ReminderUnit;
                    set(i, { unit, amount: Math.min(r.amount, APPOINTMENT_LIMITS[unit].max) });
                  }}
                  className={fieldSelect}
                >
                  {REMINDER_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {UNIT_LABELS[u]}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" onClick={() => onChange(reminders.filter((_, j) => j !== i))} className={`${button('ghost', 'sm')} ml-auto`}>
                Remover
              </button>
            </div>
            <label className="mt-2 block">
              <span className={fieldLabel}>Texto do lembrete</span>
              <textarea
                rows={3}
                maxLength={SCHEDULE_TEXT_MAX}
                value={r.text}
                onChange={(e) => set(i, { text: e.target.value })}
                className={fieldArea}
              />
            </label>
            <p className={fieldHint}>{'Marcadores: {nome}, {titulo}, {data}, {hora}'}</p>
            {problem ? (
              <p className={fieldError}>{problem}</p>
            ) : (
              props.sample &&
              r.text.trim() && <p className={fieldHint}>Vai sair assim: {fillReminderText(r.text.trim(), props.sample)}</p>
            )}
            {late && <p className={warning}>Não será enviado: o horário de envio já passou</p>}
          </div>
        );
      })}
      {reminders.length < APPOINTMENT_LIMITS.remindersMax && (
        <button
          type="button"
          onClick={() => onChange([...reminders, { amount: 1, unit: 'days', text: '' }])}
          className={`${button('secondary', 'sm')} self-start`}
        >
          <PlusIcon size={14} aria-hidden /> Adicionar lembrete
        </button>
      )}
    </div>
  );
}

/** Read-only: each reminder's lead time and situation (decision 3: reminders are only chosen when the appointment is made). */
function ReminderStatusList({ reminders }: { reminders: AppointmentReminderDto[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-[13px] leading-[18px]">
      {reminders.map((r) => (
        <li key={r.id} className="flex flex-wrap gap-x-1.5">
          <span className="font-semibold text-fg">{reminderLead(r)}</span>
          <span aria-hidden className="text-muted">
            ·
          </span>
          <span className={r.status === 'failed' ? 'text-danger' : 'text-muted'}>{reminderStatus(r)}</span>
        </li>
      ))}
    </ul>
  );
}

type DialogProps = {
  /** New, in this chat (the conversation's dialog). */
  chatId?: string;
  /** The chat's contact name, for {nome} and the preview. */
  contactName?: string | null;
  /** Edit this one. Without it and without chatId (the Agenda), "Cliente" picks the contact and the server picks the chat. */
  appointment?: AppointmentDto;
  onClose: () => void;
};

/**
 * "Novo compromisso" / "Editar compromisso" (spec 2026-10-21 compromissos §3.1–3.3). The time is typed in Cuiabá time.
 * A new one starts with the default reminders of Configurações; an edit changes title, time and note only.
 */
export function AppointmentDialog(props: DialogProps) {
  const dialogTitle = props.appointment ? 'Editar compromisso' : 'Novo compromisso';
  const defaults = useQuery({
    queryKey: qk.appointmentReminders, queryFn: api.settings.appointmentReminders.get, enabled: !props.appointment,
  });
  if (!props.appointment && !defaults.data) {
    return (
      <Modal title={dialogTitle} onCancel={props.onClose}>
        {defaults.isError ? (
          <p role="alert" className={fieldError}>
            {errorMessage(defaults.error)}
          </p>
        ) : (
          <p className="text-sm text-muted">Carregando…</p>
        )}
      </Modal>
    );
  }
  return <AppointmentForm {...props} dialogTitle={dialogTitle} defaults={defaults.data?.reminders ?? []} />;
}

function AppointmentForm(props: DialogProps & { dialogTitle: string; defaults: ReminderInput[] }) {
  const refresh = useRefresh();
  const a = props.appointment;
  const ids = { client: useId(), title: useId(), when: useId(), note: useId() };
  const initialLocal = a ? isoToOfficeLocal(a.startsAt) : '';
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState(a?.title ?? '');
  const [local, setLocal] = useState(initialLocal);
  const [note, setNote] = useState(a?.note ?? '');
  const [reminders, setReminders] = useState(props.defaults);
  const [signature, setSignature] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickContact = !a && !props.chatId;
  // {nome}: the chosen contact's name on the Agenda (undefined until one is chosen), else the chat's contact
  const contactName = pickContact ? (contact ? contact.name : undefined) : props.contactName;
  const iso = officeLocalToIso(local);
  const startsAt = iso ? new Date(iso) : null;
  const now = Date.now();
  const term = query.trim();
  // ponytail: one request per keystroke (cached per term), like "Nova conversa"
  const search = { q: term, limit: 8 };
  const results = useQuery({
    queryKey: qk.contactList(search),
    queryFn: () => api.contacts.list(search),
    enabled: pickContact && !contact && term.length >= 2,
  });

  async function save() {
    const kept = !!a && local === initialLocal; // a kept time is not checked again: it may have passed
    const problem =
      (pickContact && !contact ? 'Escolha o cliente' : null) ??
      (!title.trim() ? 'Digite o título' : null) ??
      (kept ? null : appointmentTimeProblem(startsAt, new Date())) ??
      (a ? null : remindersProblem(reminders, startsAt, contactName));
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      if (a) {
        const patch = {
          ...(title.trim() !== a.title ? { title: title.trim() } : {}),
          ...(kept ? {} : { startsAt: iso! }),
          ...(note.trim() !== (a.note ?? '') ? { note: note.trim() || null } : {}),
        };
        if (Object.keys(patch).length) await api.appointments.update(a.id, patch);
      } else {
        await api.appointments.create({
          ...(contact ? { contactId: contact.id } : { chatId: props.chatId }),
          title: title.trim(),
          startsAt: iso!,
          ...(note.trim() ? { note: note.trim() } : {}),
          signature,
          reminders,
        });
      }
      await refresh();
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={props.dialogTitle} onCancel={props.onClose}>
      <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto">
        {pickContact &&
          (contact ? (
            <div>
              <span className={fieldLabel}>Cliente</span>
              <div className="flex h-11 items-center gap-2 rounded-block bg-sunken pr-1.5 pl-3.5 text-sm font-semibold tabular-nums">
                <span className="flex-1 truncate">{contactLabel(contact)}</span>
                <button type="button" onClick={() => setContact(null)} className={button('secondary', 'sm')}>
                  Trocar
                </button>
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor={ids.client} className={fieldLabel}>
                Cliente
              </label>
              <input id={ids.client} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nome ou telefone" className={field} />
              {!!results.data?.items.length && (
                <ul className="mt-1 max-h-40 overflow-y-auto rounded-block border border-border p-1">
                  {results.data.items.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setContact(c)} className={`${menuItem} tabular-nums`}>
                        {contactLabel(c)}
                        {c.name && c.phone ? ` · ${contactLabel({ name: null, phone: c.phone })}` : ''}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        <div>
          <label htmlFor={ids.title} className={fieldLabel}>
            Título
          </label>
          <input
            id={ids.title}
            value={title}
            maxLength={APPOINTMENT_LIMITS.titleMax}
            placeholder="Ex.: Audiência, Retorno de documento"
            onChange={(e) => setTitle(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label htmlFor={ids.when} className={fieldLabel}>
            Data e hora (horário de Cuiabá)
          </label>
          <input
            id={ids.when}
            type="datetime-local"
            value={local}
            min={isoToOfficeLocal(new Date(now).toISOString())}
            max={isoToOfficeLocal(new Date(now + SCHEDULE_MAX_AHEAD_MS).toISOString())}
            onChange={(e) => setLocal(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label htmlFor={ids.note} className={fieldLabel}>
            Observação interna (não é enviada ao cliente)
          </label>
          <textarea
            id={ids.note}
            rows={2}
            maxLength={APPOINTMENT_LIMITS.noteMax}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={fieldArea}
          />
        </div>
        <div>
          <span className={fieldLabel}>Lembretes</span>
          {a ? (
            <ReminderStatusList reminders={a.reminders} />
          ) : (
            <ReminderRows
              reminders={reminders}
              onChange={setReminders}
              contactName={contactName}
              startsAt={startsAt}
              sample={startsAt ? { nome: contactName ?? '', titulo: title.trim(), startsAt: startsAt.toISOString() } : null}
            />
          )}
        </div>
        {!a && (
          <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold">
            <input type="checkbox" checked={signature} onChange={(e) => setSignature(e.target.checked)} className={checkbox} />
            Enviar com minha assinatura
          </label>
        )}
      </div>
      <Actions busy={busy} error={error} confirmLabel="Salvar" onCancel={props.onClose} onConfirm={() => void save()} />
    </Modal>
  );
}

/** One appointment (spec §3.4–3.5): when, what, for whom (page), by whom, the note, its reminders; Editar / Cancelar when canEdit. */
export function AppointmentItem({ item, page = false }: { item: AppointmentDto; page?: boolean }) {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    const ok = await confirmDialog({
      title: 'Cancelar o compromisso?',
      body: 'Os lembretes que ainda não saíram não serão enviados.',
      confirmLabel: 'Cancelar compromisso',
      cancelLabel: 'Manter compromisso',
    });
    if (!ok) return;
    setError(null);
    try {
      await api.appointments.cancel(item.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[18px] text-muted">
          <span className="font-bold text-fg tabular-nums">{formatOfficeDateTime(item.startsAt)}</span>
          <span className="font-bold text-fg">{item.title}</span>
          {page && (
            <Link to={`/chats/${item.chatId}`} className="font-bold text-link hover:underline">
              {contactLabel(item.contact)}
            </Link>
          )}
          <span>por {item.authorName}</span>
          {item.canceledAt && <span className={`${badge} ${badgeTone.neutral}`}>Cancelado</span>}
        </p>
        {item.note && (
          <div className="rounded-block bg-sunken px-2.5 py-1.5 text-[13px] leading-[18px] text-fg">
            <p className="text-xs font-bold text-muted">Observação interna</p>
            <p className="break-words whitespace-pre-wrap">{item.note}</p>
          </div>
        )}
        <ReminderStatusList reminders={item.reminders} />
        {error && (
          <p role="alert" className={fieldError}>
            {error}
          </p>
        )}
      </div>
      {item.canEdit && (
        <span className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className={button('secondary', 'sm')}>
            Editar
          </button>
          <button type="button" onClick={() => void cancel()} className={button('danger', 'sm')}>
            Cancelar
          </button>
        </span>
      )}
      {editing && <AppointmentDialog appointment={item} onClose={() => setEditing(false)} />}
    </li>
  );
}

/** Spec §3.4: "Compromissos de <cliente>": the contact's upcoming appointments in every chat of theirs the user sees. */
export function ChatAppointmentsDialog({ chat, onClose }: { chat: Pick<ChatDetail, 'id' | 'contact'>; onClose: () => void }) {
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: qk.chatAppointments(chat.id), queryFn: () => api.appointments.listForChat(chat.id) });
  return (
    <Modal title={`Compromissos de ${contactLabel(chat.contact)}`} onCancel={onClose}>
      <div className="max-h-[60vh] overflow-y-auto">
        {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
        {list.isError && (
          <p role="alert" className={fieldError}>
            {errorMessage(list.error)}
          </p>
        )}
        {list.data?.length === 0 && <p className="text-sm text-muted">Nenhum compromisso marcado com este cliente.</p>}
        {!!list.data?.length && (
          <ul className="divide-y divide-border">
            {list.data.map((a) => (
              <AppointmentItem key={a.id} item={a} />
            ))}
          </ul>
        )}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <Link to="/agendamentos?aba=compromissos" className="text-[13px] font-bold text-link hover:underline">
          Ver todos os compromissos
        </Link>
        <span className="flex flex-wrap gap-2">
          <button type="button" onClick={onClose} className={button('secondary')}>
            Fechar
          </button>
          <button type="button" onClick={() => setCreating(true)} className={button('primary')}>
            <PlusIcon size={16} aria-hidden /> Novo compromisso
          </button>
        </span>
      </div>
      {creating && <AppointmentDialog chatId={chat.id} contactName={chat.contact.name} onClose={() => setCreating(false)} />}
    </Modal>
  );
}
```

- [ ] **Step 5: The header button and the refresh on `chat.updated`**

In `web/src/components/conversation/ConversationHeader.tsx`, replace

```tsx
import {
  ArrowCounterClockwise, ArrowsLeftRight, Check, LockSimple, LockSimpleOpen, MagnifyingGlass, User, UserPlus,
} from '@phosphor-icons/react';
```

with

```tsx
import {
  ArrowCounterClockwise, ArrowsLeftRight, CalendarStarIcon, Check, LockSimple, LockSimpleOpen, MagnifyingGlass, User, UserPlus,
} from '@phosphor-icons/react';
```

replace

```tsx
import { BotRunningDialog, CloseDialog, TransferDialog } from './ChatDialogs';
```

with

```tsx
import { ChatAppointmentsDialog } from './Appointments';
import { BotRunningDialog, CloseDialog, TransferDialog } from './ChatDialogs';
```

replace

```tsx
  const [dialog, setDialog] = useState<'transfer' | 'close' | null>(null);
```

with

```tsx
  const [dialog, setDialog] = useState<'transfer' | 'close' | null>(null);
  const [appointmentsOpen, setAppointmentsOpen] = useState(false); // spec 2026-10-21 compromissos §3.1
```

replace

```tsx
          <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
            <User size={18} />
          </HeaderButton>
```

with

```tsx
          <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
            <User size={18} />
          </HeaderButton>
          {/* open, closed and history chats alike: the reminder's send opens a new chat when needed */}
          <HeaderButton label="Compromissos" onClick={() => setAppointmentsOpen(true)}>
            <CalendarStarIcon size={18} />
          </HeaderButton>
```

and replace

```tsx
            if (botAction) void act({ ...retry, botAction });
          }}
        />
      )}
```

with

```tsx
            if (botAction) void act({ ...retry, botAction });
          }}
        />
      )}
      {appointmentsOpen && <ChatAppointmentsDialog chat={chat} onClose={() => setAppointmentsOpen(false)} />}
```

In `web/src/components/conversation/ConversationView.tsx`, replace

```tsx
    void qc.invalidateQueries({ queryKey: qk.chatScheduled(chatId), exact: true });
  });
```

with

```tsx
    void qc.invalidateQueries({ queryKey: qk.chatScheduled(chatId), exact: true });
    // making, moving and cancelling an appointment publish chat.updated too (spec 2026-10-21 compromissos §3.1)
    void qc.invalidateQueries({ queryKey: qk.chatAppointments(chatId), exact: true });
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/conversation`
Expected: PASS.

Run: `npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/conversation/Appointments.tsx web/src/components/conversation/Appointments.test.tsx web/src/components/conversation/ChatDialogs.tsx web/src/components/conversation/ConversationHeader.tsx web/src/components/conversation/ConversationHeader.test.tsx web/src/components/conversation/ConversationView.tsx
git commit -m "feat(web): appointment form and the Compromissos dialog in the conversation header" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The Agenda's "Mensagens" and "Compromissos" tabs

The page stays at `/agendamentos` with its `h1` and its `card`. The top `tabList` switches with `?aba=compromissos`; without the parameter it opens "Mensagens", as today. Each tab keeps its own parameter (`status`, `situacao`, decision 2). Switching tabs only sets or removes `aba`, so neither filter is lost. The failure toast's `?status=failed` link still opens "Mensagens → Falharam".

**Files:**
- Modify: `web/src/pages/ScheduledMessages.tsx` (whole file)
- Test: `web/src/pages/ScheduledMessages.test.tsx`

**Interfaces:**
- Consumes: Task 1 `APPOINTMENT_TABS`; Task 6 `api.appointments.list`, `qk.appointmentList`; Task 7 `AppointmentItem`, `AppointmentDialog`.
- Produces: `ScheduledMessagesPage` with `?aba=compromissos&situacao=upcoming|past|canceled`.

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/ScheduledMessages.test.tsx`, replace

```tsx
import type { ScheduledMessageDto } from '@talk/shared';
import { ScheduledMessagesPage } from './ScheduledMessages';
```

with

```tsx
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto, type ScheduledMessageDto } from '@talk/shared';
import { ScheduledMessagesPage } from './ScheduledMessages';

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const appointment = (over: Partial<AppointmentDto> = {}): AppointmentDto => ({
  id: 'a1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
  title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', note: null, canceledAt: null, canceledByName: null,
  createdAt: '2026-10-20T12:00:00.000Z', canEdit: true,
  reminders: [{ id: 'r1', amount: 1, unit: 'hours', text: 'Olá', sendAt: '2026-10-21T17:00:00.000Z', status: 'pending', scheduledId: 's1', error: null }],
  ...over,
});
```

and append at the end of the file:

```tsx
it('?aba=compromissos opens Compromissos on Próximos; each tab keeps its own filter (spec 2026-10-21 compromissos §3.5)', async () => {
  stubFetch({
    'GET /api/appointments?tab=upcoming': [appointment()],
    'GET /api/appointments?tab=canceled': [appointment({ id: 'a2', title: 'Perícia', canceledAt: '2026-10-20T12:00:00.000Z', canEdit: false })],
    'GET /api/scheduled-messages?status=failed': [],
  });
  renderPage('/agendamentos?aba=compromissos&status=failed');
  expect(await screen.findByText('Audiência')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Compromissos' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Próximos' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('link', { name: 'Maria Cliente' }).getAttribute('href')).toBe('/chats/c1');
  expect(screen.getByText('Pendente · 21/10/2026 13:00')).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', { name: 'Cancelados' }));
  expect(await screen.findByText('Cancelado')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'Mensagens' }));
  expect(await screen.findByText('Nenhuma mensagem aqui.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Falharam' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'Compromissos' }));
  expect(screen.getByRole('tab', { name: 'Cancelados' }).getAttribute('aria-selected')).toBe('true');
});

it('an empty tab says "Nenhum compromisso aqui.", and "Novo compromisso" opens the form with "Cliente"', async () => {
  stubFetch({ 'GET /api/appointments?tab=past': [], 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
  renderPage('/agendamentos?aba=compromissos&situacao=past');
  expect(await screen.findByText('Nenhum compromisso aqui.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Passados' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Novo compromisso' }));
  expect(await screen.findByLabelText('Cliente')).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/pages/ScheduledMessages.test.tsx`
Expected: FAIL on the two new tests: there is no "Compromissos" tab.

- [ ] **Step 3: Write the page**

Replace the whole content of `web/src/pages/ScheduledMessages.tsx` with:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { PlusIcon } from '@phosphor-icons/react';
import { APPOINTMENT_TABS, SCHEDULED_TABS, type AppointmentTab, type ScheduledTab } from '@talk/shared';
import { AppointmentDialog, AppointmentItem } from '../components/conversation/Appointments';
import { ScheduledItem } from '../components/conversation/Scheduled';
import { button, card, pageTitle, tab as tabClass, tabList } from '../components/ui';
import { api, qk } from '../lib/api';

const TAB_LABELS: Record<ScheduledTab, string> = { pending: 'Pendentes', sent: 'Enviadas', failed: 'Falharam', canceled: 'Canceladas' };
const APPOINTMENT_TAB_LABELS: Record<AppointmentTab, string> = { upcoming: 'Próximos', past: 'Passados', canceled: 'Cancelados' };
const isTab = (v: string | null): v is ScheduledTab => (SCHEDULED_TABS as readonly string[]).includes(v ?? '');
const isAppointmentTab = (v: string | null): v is AppointmentTab => (APPOINTMENT_TABS as readonly string[]).includes(v ?? '');
const errorText = 'text-[13px] font-semibold text-danger';

/**
 * The Agenda. Spec 2026-10-20 agendamentos §3.2: "Mensagens", the scheduled messages (?status=). Spec 2026-10-21
 * compromissos §3.5: "Compromissos" (?aba=compromissos&situacao=). Each tab keeps its own parameter, so switching loses neither.
 */
export function ScheduledMessagesPage() {
  const [params, setParams] = useSearchParams();
  const appointmentsView = params.get('aba') === 'compromissos';
  const set = (key: string, value: string | null) =>
    setParams((p) => {
      if (value === null) p.delete(key);
      else p.set(key, value);
      return p;
    });
  const status = params.get('status');
  const situation = params.get('situacao');

  return (
    <div className={`${card} flex h-full flex-col gap-[18px] overflow-y-auto px-[18px] py-[22px]`}>
      <h1 className={pageTitle}>Agendamentos</h1>
      <div role="tablist" aria-label="Agenda" className={tabList}>
        <button type="button" role="tab" aria-selected={!appointmentsView} onClick={() => set('aba', null)} className={tabClass(!appointmentsView)}>
          Mensagens
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={appointmentsView}
          onClick={() => set('aba', 'compromissos')}
          className={tabClass(appointmentsView)}
        >
          Compromissos
        </button>
      </div>
      {appointmentsView ? (
        <AppointmentsTab tab={isAppointmentTab(situation) ? situation : 'upcoming'} onTab={(t) => set('situacao', t)} />
      ) : (
        <MessagesTab tab={isTab(status) ? status : 'pending'} onTab={(t) => set('status', t)} />
      )}
    </div>
  );
}

/** An agent's own scheduled messages (an admin's: everyone's), one tab per status. */
function MessagesTab({ tab, onTab }: { tab: ScheduledTab; onTab: (t: ScheduledTab) => void }) {
  // ponytail: polls every 30 s instead of a WS event of its own; the page's own changes refresh it at once
  const list = useQuery({ queryKey: qk.scheduledList(tab), queryFn: () => api.scheduled.list(tab), refetchInterval: 30_000 });
  return (
    <>
      <div role="tablist" aria-label="Situação" className={tabList}>
        {SCHEDULED_TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} onClick={() => onTab(t)} className={tabClass(t === tab)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {list.isError && (
        <p role="alert" className={errorText}>
          Não foi possível carregar os agendamentos.
        </p>
      )}
      {list.data?.length === 0 && <p className="text-sm text-muted">Nenhuma mensagem aqui.</p>}
      {!!list.data?.length && (
        <ul className="max-w-[800px] divide-y divide-border">
          {list.data.map((i) => (
            <ScheduledItem key={i.id} item={i} page />
          ))}
        </ul>
      )}
    </>
  );
}

/** Spec 2026-10-21 compromissos §3.5: mine (an admin: everyone's); Próximos, Passados, Cancelados; "Novo compromisso". */
function AppointmentsTab({ tab, onTab }: { tab: AppointmentTab; onTab: (t: AppointmentTab) => void }) {
  const [creating, setCreating] = useState(false);
  // ponytail: polls every 30 s like the messages tab (spec §10: no real-time notice on the page)
  const list = useQuery({ queryKey: qk.appointmentList(tab), queryFn: () => api.appointments.list(tab), refetchInterval: 30_000 });
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Situação dos compromissos" className={tabList}>
          {APPOINTMENT_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === tab} onClick={() => onTab(t)} className={tabClass(t === tab)}>
              {APPOINTMENT_TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setCreating(true)} className={button('primary')}>
          <PlusIcon size={16} aria-hidden /> Novo compromisso
        </button>
      </div>
      {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {list.isError && (
        <p role="alert" className={errorText}>
          Não foi possível carregar os compromissos.
        </p>
      )}
      {list.data?.length === 0 && <p className="text-sm text-muted">Nenhum compromisso aqui.</p>}
      {!!list.data?.length && (
        <ul className="max-w-[800px] divide-y divide-border">
          {list.data.map((a) => (
            <AppointmentItem key={a.id} item={a} page />
          ))}
        </ul>
      )}
      {creating && <AppointmentDialog onClose={() => setCreating(false)} />}
    </>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/pages/ScheduledMessages.test.tsx src/components/layout`
Expected: PASS: the old tests (`?status=failed`, Pendentes by default) and the new ones; the toast's link test still passes.

Run: `npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ScheduledMessages.tsx web/src/pages/ScheduledMessages.test.tsx
git commit -m "feat(web): Agenda tabs Mensagens and Compromissos (Próximos, Passados, Cancelados)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Configurações → Compromissos

The page follows the Ajustes pattern of `AutoRulesSettings`: `PageHeader` with the spec's help text, one `SettingsSection` and the `SaveBar`. The editor is Task 7's `ReminderRows`, with a fixed sample (decision 9). `SaveBar` gains `savedText`, for "Lembretes salvos.". While a line breaks a rule, `SaveBar` shows the problem and Salvar is disabled.

**Files:**
- Modify: `web/src/components/settings/common.tsx` (`SaveBar`)
- Create: `web/src/pages/settings/AppointmentSettings.tsx`
- Modify: `web/src/pages/settings/SettingsPage.tsx` (icon, import, section)
- Test: `web/src/pages/settings/AppointmentSettings.test.tsx` (create), `web/src/pages/settings/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: Task 1 `remindersProblem`, `AppointmentRemindersDto`; Task 6 `api.settings.appointmentReminders`, `qk.appointmentReminders`; Task 7 `ReminderRows`, `ReminderSample`; `PageHeader`, `SettingsSection`, `SaveBar`, `Loading`, `useSend`.
- Produces: `AppointmentSettings` at `/configuracoes/compromissos` (group "Atendimento", after "Regras automáticas", admin only); `SaveBar.savedText`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/pages/settings/AppointmentSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentRemindersDto } from '@talk/shared';
import { AppointmentSettings } from './AppointmentSettings';

let saved: AppointmentRemindersDto;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  saved = DEFAULT_APPOINTMENT_REMINDERS;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/settings/appointment-reminders' && method === 'GET') return json(saved);
    if (path === '/api/settings/appointment-reminders' && method === 'PUT') {
      // like the server: the texts come back trimmed, and the next GET answers with what was saved
      saved = { reminders: (body as AppointmentRemindersDto).reminders.map((r) => ({ ...r, text: r.text.trim() })) };
      return json(saved);
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads the defaults, checks the rules live and saves the reminders (spec 2026-10-21 compromissos §4)', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppointmentSettings />
    </QueryClientProvider>,
  );

  await screen.findByRole('heading', { level: 1, name: 'Compromissos' });
  expect(screen.getByText('Lembretes que já vêm preenchidos em todo compromisso novo. Cada compromisso pode mudar os seus.')).toBeTruthy();
  const second = screen.getByRole('group', { name: 'Lembrete 2' });
  expect(within(second).getByText('Vai sair assim: Olá, Maria! Seu compromisso (Audiência) é às 14:00 de 10/11/2026 (horário de Cuiabá).')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull(); // nothing changed yet

  fireEvent.change(within(second).getByLabelText('Texto do lembrete'), { target: { value: 'Oi, {Nome}!' } });
  expect(screen.getAllByText('Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}').length).toBeGreaterThan(0);
  expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(within(second).getByLabelText('Texto do lembrete'), { target: { value: '  Hoje às {hora}, {nome}.  ' } });
  fireEvent.change(within(second).getByLabelText('Antecedência'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar lembrete' }));
  const third = screen.getByRole('group', { name: 'Lembrete 3' });
  fireEvent.change(within(third).getByLabelText('Antecedência'), { target: { value: '7' } });
  fireEvent.change(within(third).getByLabelText('Texto do lembrete'), { target: { value: 'Falta uma semana: {titulo}.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Lembretes salvos.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    reminders: [
      DEFAULT_APPOINTMENT_REMINDERS.reminders[0],
      { amount: 3, unit: 'hours', text: '  Hoje às {hora}, {nome}.  ' },
      { amount: 7, unit: 'days', text: 'Falta uma semana: {titulo}.' },
    ],
  });
});
```

In `web/src/pages/settings/SettingsPage.test.tsx`, replace

```tsx
  fireEvent.change(search, { target: { value: 'regras auto' } });
  expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Regras automáticas']);
```

with

```tsx
  fireEvent.change(search, { target: { value: 'regras auto' } });
  expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Regras automáticas']);

  fireEvent.change(search, { target: { value: 'compromissos' } }); // spec 2026-10-21 compromissos §4
  expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
    ['Compromissos', '/configuracoes/compromissos'],
  ]);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/pages/settings/AppointmentSettings.test.tsx src/pages/settings/SettingsPage.test.tsx`
Expected: FAIL. `./AppointmentSettings` does not exist, and the search finds no "Compromissos".

- [ ] **Step 3: Let `SaveBar` say what was saved**

In `web/src/components/settings/common.tsx`, replace

```tsx
  /** Salvar disabled (invalid form). */
  disabled?: boolean;
}) {
```

with

```tsx
  /** Salvar disabled (invalid form). */
  disabled?: boolean;
  /** What it says after a save; "Alterações salvas." by default (Compromissos: "Lembretes salvos."). */
  savedText?: string;
}) {
```

and replace

```tsx
        <p role="status" className={`${okText} mr-auto py-2.5`}>
          Alterações salvas.
        </p>
```

with

```tsx
        <p role="status" className={`${okText} mr-auto py-2.5`}>
          {props.savedText ?? 'Alterações salvas.'}
        </p>
```

- [ ] **Step 4: Write the page and add it to Configurações**

Create `web/src/pages/settings/AppointmentSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { remindersProblem, type AppointmentRemindersDto } from '@talk/shared';
import { ReminderRows, type ReminderSample } from '../../components/conversation/Appointments';
import { api, qk } from '../../lib/api';
import { Loading, PageHeader, SaveBar, SettingsSection, useSend } from '../../components/settings/common';

// ponytail: a fixed example for "Vai sair assim" (10/11/2026 14:00 in Cuiabá); there is no appointment on this page
const SAMPLE: ReminderSample = { nome: 'Maria', titulo: 'Audiência', startsAt: '2026-11-10T18:00:00.000Z' };

export function AppointmentSettings() {
  const saved = useQuery({ queryKey: qk.appointmentReminders, queryFn: api.settings.appointmentReminders.get });
  if (!saved.data) return <Loading error={saved.error} />;
  return <AppointmentRemindersForm saved={saved.data} />;
}

/** Spec 2026-10-21 compromissos §4: the reminders every new appointment starts with; the server checks the same rules. */
function AppointmentRemindersForm({ saved }: { saved: AppointmentRemindersDto }) {
  const [reminders, setReminders] = useState(saved.reminders);
  const save = useSend(qk.appointmentReminders);
  const dirty = JSON.stringify(reminders) !== JSON.stringify(saved.reminders);
  const problem = remindersProblem(reminders, null); // no contact here: {nome} is fine

  function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    // keep the server's answer (trimmed texts), or the form would stay "unsaved"
    save.mutate(async () => setReminders((await api.settings.appointmentReminders.put({ reminders })).reminders));
  }

  function discard() {
    setReminders(saved.reminders);
    save.reset();
  }

  return (
    <>
      <PageHeader
        title="Compromissos"
        description="Lembretes que já vêm preenchidos em todo compromisso novo. Cada compromisso pode mudar os seus."
      />
      <form onSubmit={submit}>
        <SettingsSection title="Lembretes">
          <ReminderRows reminders={reminders} onChange={setReminders} sample={SAMPLE} />
        </SettingsSection>
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onDiscard={discard}
          error={save.error ?? (problem ? new Error(problem) : null)}
          saved={save.isSuccess}
          disabled={!!problem}
          savedText="Lembretes salvos."
        />
      </form>
    </>
  );
}
```

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
  BuildingsIcon, CalendarStarIcon, ChatsCircleIcon, FunnelIcon, LightningIcon, MagnifyingGlassIcon, RobotIcon, SlidersHorizontalIcon,
  TagIcon, TextAaIcon, TimerIcon, UserCircleIcon, UsersThreeIcon, WhatsappLogoIcon, type Icon,
} from '@phosphor-icons/react';
```

replace

```tsx
import { AutoRulesSettings } from './AutoRulesSettings';
```

with

```tsx
import { AutoRulesSettings } from './AutoRulesSettings';
import { AppointmentSettings } from './AppointmentSettings';
```

and replace

```tsx
  { path: 'regras', label: 'Regras automáticas', icon: TimerIcon, group: 'Atendimento', adminOnly: true, page: AutoRulesSettings },
```

with

```tsx
  { path: 'regras', label: 'Regras automáticas', icon: TimerIcon, group: 'Atendimento', adminOnly: true, page: AutoRulesSettings },
  { path: 'compromissos', label: 'Compromissos', icon: CalendarStarIcon, group: 'Atendimento', adminOnly: true, page: AppointmentSettings },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w web -- src/pages/settings src/components/settings`
Expected: PASS. The `SaveBar` tests in `common.test.tsx` still read "Alterações salvas.".

Run: `npm test` (all workspaces) and `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/settings/common.tsx web/src/pages/settings/AppointmentSettings.tsx web/src/pages/settings/AppointmentSettings.test.tsx web/src/pages/settings/SettingsPage.tsx web/src/pages/settings/SettingsPage.test.tsx
git commit -m "feat(web): Configurações → Compromissos with the default reminders" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Manual acceptance script

The steps of spec §8, in the format of the earlier acceptance scripts (`2026-10-16-acoes-mensagem-aceite.md`). The user runs them by hand with the test number. This task only writes the file.

**Files:**
- Create: `docs/superpowers/plans/2026-10-21-compromissos-aceite.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the script the user runs before merging.

- [ ] **Step 1: Write the script**

Create `docs/superpowers/plans/2026-10-21-compromissos-aceite.md`:

````markdown
# Aceite manual: compromissos

Roteiro do §8 da [especificação](../specs/2026-10-21-compromissos-design.md). Rode no ambiente local, com o número de teste e um segundo celular fazendo o papel do cliente.

> ⚠️ Use só o **número de teste**. Se você ler o QR com o número do escritório, ele sai do Umbler Talk na hora.

## 0. Antes de começar

- [ ] Testes automáticos passando:

```bash
npm test
npm run typecheck
```

- [ ] O ambiente local está rodando (`npm run dev:up` e `npm run dev`), o servidor reiniciou depois da migração `0009_compromissos`, e o canal do número de teste aparece como **Conectado**.
- [ ] Existe uma conversa aberta com o celular do "cliente", atribuída a você, e o contato tem **nome** cadastrado.
- [ ] A sua assinatura está preenchida em **Ajustes → Perfil**.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

## 1. Lembretes padrão

- [ ] Como administrador, abra **Ajustes → Compromissos**. Aparecem "2 dias antes" e "1 hora antes" com os textos padrão, cada um com "Vai sair assim: …".

## 2. Compromisso na conversa

- [ ] Na conversa de teste, clique em **Compromissos** (no cabeçalho, ao lado de Contato). O diálogo "Compromissos de <cliente>" diz "Nenhum compromisso marcado com este cliente.".
- [ ] Clique em **Novo compromisso**. Título "Audiência teste", data e hora = agora + 1 h 05 min (horário de Cuiabá), os dois lembretes padrão.
- [ ] Antes de salvar, a linha "2 dias antes" diz "Não será enviado: o horário de envio já passou".
- [ ] Salve. A linha do tempo mostra "Compromisso “Audiência teste” marcado por <você> para <data>".
- [ ] Acima do compositor aparece "1 mensagem agendada". Aberta, a linha mostra "Lembrete · Audiência teste" no lugar de Editar/Cancelar.
- [ ] Em **Agenda → Mensagens → Pendentes**, o lembrete aparece com "Lembrete · Audiência teste" e sem Editar/Cancelar.
- [ ] Em até 5 minutos, o celular do cliente recebe o texto com o nome, a data e a hora certos, com a sua assinatura; no sistema a bolha tem a marca **Agendada**.

## 3. Remarcar

- [ ] Crie "Remarcação teste" para agora + 1 h 10 min, só com "1 hora antes".
- [ ] Em **Compromissos**, clique em **Editar** e mude a hora para agora + 1 h 20 min. Salve.
- [ ] A Agenda mostra o lembrete no horário novo, e a linha do tempo mostra "Compromisso “Remarcação teste” remarcado por <você> para <data>".
- [ ] O cliente recebe a mensagem **uma vez só**, no horário novo.

## 4. Cancelar

- [ ] Crie "Cancelamento teste" para amanhã, com "1 hora antes". Em **Compromissos**, clique em **Cancelar**: aparece "Cancelar o compromisso?" com "Os lembretes que ainda não saíram não serão enviados.". Clique em **Cancelar compromisso**.
- [ ] O lembrete vai para **Agenda → Mensagens → Canceladas**, e o compromisso para **Agenda → Compromissos → Cancelados**, com a marca "Cancelado".

## 5. Pela Agenda, com a conversa finalizada

- [ ] Finalize a conversa de teste.
- [ ] Em **Agenda → Compromissos**, clique em **Novo compromisso**. Em **Cliente**, digite duas letras do nome do cliente e escolha-o. Título "Retorno teste", agora + 1 h 05 min, só "1 hora antes".
- [ ] Em até 5 minutos, o lembrete abre uma conversa nova no mesmo setor, com você como atendente, e o cliente recebe a mensagem.

## 6. Abas e assinatura

- [ ] Na Agenda, alterne entre **Mensagens** e **Compromissos**: cada aba volta no filtro em que estava.
- [ ] Na conversa, em **Compromissos**, o link **Ver todos os compromissos** abre a Agenda já na aba Compromissos.
- [ ] Crie um compromisso para agora + 1 h 05 min, com "1 hora antes" e **Enviar com minha assinatura** desmarcada: o lembrete chega ao cliente **sem** assinatura.

## Resultado

- [ ] Tudo certo → anote "aceite ok <versão>" no PR.
- Problemas encontrados: `________`
````

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-21-compromissos-aceite.md
git commit -m "docs: roteiro de aceite dos compromissos" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review checklist (for the executor, after Task 10)

- [ ] Spec §3.1:
  - the header button in open, closed and history chats (Task 7);
  - the Agenda form with "Cliente" from 2 letters (Tasks 7, 8);
  - the server's chat choice for a `contactId`: open → newest visible → 400 (Task 2);
  - the time rules from the same `appointmentTimeProblem` on both sides (Tasks 1, 2, 7);
  - one transaction with the event and `chat.updated` (Task 2).
- [ ] Spec §3.2:
  - placeholders filled on save and on recalculation, never at send time; `{nome}` without a name refused (Tasks 1–3);
  - "N dias antes" in Cuiabá wall time; hours exact (Task 1);
  - "Não criado" both live in the form and after saving (Tasks 2, 7);
  - same-time reminders refused (Tasks 1, 2, 7);
  - author and signature of the appointment (Tasks 2, 3).
- [ ] Spec §3.3:
  - 404 / 409 for editing and cancelling; a kept time not checked again; a note-only edit recalculates nothing (Task 3);
  - the in-place table: pending → update or delete, "Não criado" → insert, sending/sent/failed untouched (Task 3);
  - "remarcado" only when the time moves; cancel moves pending rows to `canceled` with `finished_at` (Task 3).
- [ ] Spec §3.4–3.5:
  - the chat's list covers the contact across the chats the user sees (Task 2);
  - the Agenda tabs and their order, 100 rows, the 30 s refresh, `?aba=` and a filter parameter per tab (Tasks 2, 8).
- [ ] Spec §3.6: `git diff af9b84e -- server/src/automation/delivery.ts` prints nothing; the inactivity rule ignores reminders (Task 4).
- [ ] Spec §3.7: `canEdit` false, the 409s in the order 404 → reminder → not pending, and the mark linking to the Compromissos tab (Tasks 4, 6).
- [ ] Spec §3.8: delete and merge (Task 4).
- [ ] Spec §4: GET for everyone, PUT for admins, defaults when the value is missing or invalid, "Lembretes salvos." (Tasks 5, 9).
- [ ] Spec §5: `0009_compromissos` holds only the 12 statements of Task 1 Step 6. Check with `git diff af9b84e --stat -- server/drizzle`: only 0009 and the journal change.
- [ ] Spec §6: every string of the Global Constraints list appears verbatim (`grep -rn` the UI strings in `web/src`).
- [ ] `grep -rn "console\." server/src/automation/appointments.ts` prints nothing.
- [ ] Delivery 3 and the Ajustes redesign survive:
  - the scheduled-message, rules, delivery and settings suites pass unchanged except for the added tests;
  - `SaveBar` still says "Alterações salvas." by default;
  - the "Agenda" menu label and `?status=failed` from the toast still work.
