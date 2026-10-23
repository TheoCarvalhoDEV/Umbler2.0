# Controle de compromissos — design

Date: 2026-10-23. Builds on `2026-10-21-compromissos-design.md` (the "base spec"); everything there stays unless this
document changes it. Approved by the user in chat ("SIM") after the short design; the user asked for all four of:
calendar (month/week), appointment situation with counters, filters and search, today highlighted.

User's words: "QUERO QUE TENHA UM CONTROLE DE AGENDAMENTOS ALI TBM, NÃO SÓ DE MENSAGENS".

## 1. Goal

The Agenda becomes the place where the office *controls* its appointments: what is coming today and tomorrow, which
client still has to confirm, who came and who missed, seen as a list, a week or a month, filtered by attendant, sector,
situation and a search. Scheduled messages stay as they are, in the second tab.

## 2. Out of scope

- No new calendar dependency; the week and month grids are plain CSS grid.
- No time-grid (hour rows) in the week view: each day is a column of appointment chips sorted by time.
- No drag-and-drop to reschedule. "Remarcar" opens the existing edit dialog.
- No change to reminders: the situation never creates, moves, cancels or sends a reminder.
- No history of situation changes (who marked it, when). Only the current situation is stored.
- No real-time push to the Agenda; it keeps polling every 30 s like today (base spec §10).
- No change to who sees what (base spec §2): an attendant sees the appointments they created; an admin sees everyone's.

## 3. Situation of an appointment

### 3.1 Values

New column `appointments.status`, text, not null, default `'scheduled'`. Shared constant:

```ts
export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'attended', 'missed'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
```

pt-BR labels: `scheduled` "Agendado", `confirmed` "Confirmado", `attended` "Compareceu", `missed` "Faltou".
A cancelled appointment (canceled_at set, base spec) shows "Cancelado" and its status is not shown or changed.

Migration `0010_situacao_compromissos` adds the column; existing rows become `'scheduled'`.
(The Umbler import branch also has a 0010; whichever branch merges second renumbers its migration.)

### 3.2 Rules (same check on server and web, one shared function)

`appointmentStatusProblem(a: { startsAt: Date; canceledAt: Date | null }, status, now): string | null` returns the pt-BR
reason a change is refused, or null:

- cancelled → "Este compromisso foi cancelado" (the existing `APPOINTMENT_CANCELED`, 409 on the server).
- `confirmed` only while `startsAt > now` → otherwise "O horário deste compromisso já passou".
- `attended` / `missed` only from the appointment's office day (America/Cuiaba) on: the office date of `startsAt`
  ≤ the office date of `now` → otherwise "Só dá para marcar presença a partir do dia do compromisso".
- `scheduled` is always allowed (it undoes a mistaken mark).
- Setting the status it already has is allowed and changes nothing (idempotent, 200).

### 3.3 Who

Whoever can edit it today (`canManage` + `canSee`, base spec §2), but **also on past appointments** (marking presence
happens after the time). Cancelled → 409. Anyone else → 404.

### 3.4 API

`POST /api/appointments/:id/status` body `{ status: AppointmentStatus }` (zod enum) → the updated `AppointmentDto`.
Emits nothing new (no WS event); the Agenda refetches.

`AppointmentDto` gains `status: AppointmentStatus` and `canMark: boolean` (= not cancelled && canManage && canSee;
`canEdit` stays as it is).

Editing the time (base spec §3.3) does not touch the status, except: moving the appointment to a new time resets a
`attended`/`missed` status to `scheduled` (a rescheduled appointment has not happened yet). `confirmed` is kept.

## 4. Listing: filters, ranges and search

`GET /api/appointments` keeps `tab` and gains optional query params (zod, all optional):

| param | meaning |
|---|---|
| `tab` | `upcoming` / `past` / `canceled` as today; ignored when `from`+`to` are given |
| `from`, `to` | ISO instants; returns all appointments, **cancelled included**, with `from ≤ starts_at < to`, ascending. Both or neither; `to > from` and `to - from` ≤ 43 days, else 400 "Período inválido" |
| `authorId` | uuid; only honoured for an admin (an attendant always gets their own) |
| `sectorId` | uuid; the chat's sector |
| `status` | an `AppointmentStatus`; excludes cancelled ones |
| `q` | trimmed, 1–80 chars; case/accent-insensitive match on the contact's name or title (`unaccent` is not available on PGlite → use `lower()` + `ILIKE` on both sides; accents are matched as typed), or on the phone when `q` has ≥ 4 digits (digits only, contains) |
| `preset` | `today` / `tomorrow` / `toConfirm` / `toMark` (the counters, §5); applies the same `where` as the counter |

The list limit becomes 100 for `tab` (as today) and 500 for a range. Order: range and `upcoming` ascending, the other
tabs descending (as today). Presets: `today`/`tomorrow`/`toConfirm` ascending, `toMark` descending.

## 5. Counters

`GET /api/appointments/summary` with the same `authorId`/`sectorId`/`q` filters (not `status`, not range) →

```ts
export interface AppointmentSummaryDto { today: number; tomorrow: number; toConfirm: number; toMark: number }
```

All exclude cancelled appointments. Office days in America/Cuiaba:

- `today`: starts_at within today's office day (past ones of today included).
- `tomorrow`: within tomorrow's office day.
- `toConfirm`: `status = 'scheduled'` and `now ≤ starts_at < now + 7 days`.
- `toMark`: `status in ('scheduled','confirmed')` and `starts_at < now`, no older than 60 days (ponytail: bound so
  ancient test rows don't sit there forever; widen if the office asks).

Office-day bounds come from one shared helper `officeDayRange(date: 'YYYY-MM-DD'): { from: Date; to: Date }` built on
`officeLocalToIso` (no DST rule assumed, same as reminders).

## 6. Web — Agenda page (`web/src/pages/ScheduledMessages.tsx`, route `/agendamentos`)

### 6.1 Tabs

The page opens on **Compromissos**. URL: no `aba` (or `aba=compromissos`, old links) → Compromissos; `aba=mensagens` →
Mensagens. The tab order becomes Compromissos, Mensagens. The messages tab is unchanged.

### 6.2 Counters strip

Four cards in a row (wrap on narrow): **Hoje**, **Amanhã**, **A confirmar**, **Presença a marcar**, each with the number
(big, tabular) and the label. A card with 0 is muted. Clicking a card switches to the Lista view with that preset
(`?filtro=today|tomorrow|toConfirm|toMark`); clicking the active card again clears it. Cards use ui.ts recipes and theme
tokens only; the active card has the primary border/tint like the active chat-list item.

### 6.3 Toolbar

One row (wraps): view switch **Lista / Semana / Mês** (`?visao=lista|semana|mes`, default lista), the filters, and the
existing **Novo compromisso** primary button at the right.

Filters (URL params `?atendente`, `?setor`, `?situacao`, `?busca`):
- **Atendente** select ("Todos os atendentes" + active users), admin only.
- **Setor** select ("Todos os setores" + sectors).
- **Situação** select ("Todas as situações" + the four labels).
- **Busca** pill ("Cliente, telefone ou título"), debounced 300 ms.
- A "Limpar filtros" text button appears when any filter is set.

The existing `?situacao=` param of the Próximos/Passados/Cancelados tabs is renamed `?periodo=` (old values still read);
`?situacao=` now means the status filter.

### 6.4 Lista view

Keeps the Próximos / Passados / Cancelados tabs (hidden while a counter preset is active). Items are grouped by office day
with a sticky day header: "Hoje", "Amanhã", "Ontem", otherwise "sex., 24 de out." (pt-BR, office timezone; the year is
added when it differs from the current one). Today's group header uses the primary color.

### 6.5 Item

`AppointmentItem` (shared with the conversation dialog) gains:
- a status badge next to the title: Agendado neutral, Confirmado info/primary, Compareceu success, Faltou danger;
  Cancelado as today.
- when `canMark`: quick actions, only those §3.2 allows right now:
  - before the time: **Confirmar** (or **Desfazer confirmação** when confirmed);
  - from the office day on: **Compareceu** and **Faltou** (the current one shown pressed; pressing it again sets
    `scheduled`);
  - after a **Faltou**: **Remarcar** (opens the edit dialog; only when `canEdit`).
- Editar / Cancelar stay as they are (they move into a ⋮ `RowMenu` on the Agenda page when space is short — optional).

Errors from the status call show under the item (as cancel errors do today).

### 6.6 Semana view

Header: ◀ / **Hoje** / ▶ and the range label "20 – 26 de out. de 2026". Weeks start on Monday. Seven columns (on a
phone: one column per day stacked). Each day: its header ("seg. 20", today highlighted with the primary tint), then
its appointments sorted by time as compact chips: time, title, client name, status color dot; cancelled ones struck
through and muted. Clicking a chip opens a details dialog that renders the `AppointmentItem` (with its actions).
Clicking the empty area of a day (or a "+" on hover) opens **Novo compromisso** with the date pre-filled at 09:00 when
that time is still in the future; for today after 09:00 the next whole hour; a past day offers no "+".
Fetch: `from`/`to` = the week's office-day bounds, with the toolbar filters. `?semana=YYYY-MM-DD` (its Monday).

### 6.7 Mês view

Header like the week (◀ / Hoje / ▶, "outubro de 2026"). A 6×7 grid (Monday first) with the days of the neighbouring
months muted. Each day shows up to 3 chips (time + title) and "+N" beyond. Today highlighted. Clicking a day opens the
Semana view on that week. Clicking a chip opens the details dialog. Fetch: `from`/`to` = the grid's first and last
office days (≤ 42 days). `?mes=YYYY-MM`.

### 6.8 New appointment pre-fill

`AppointmentDialog` gains an optional `initialStartsAt?: string` (office-local `YYYY-MM-DDTHH:mm`) used only when
creating.

## 7. Conversation dialog

`ChatAppointmentsDialog` shows the status badge and the quick actions too (same `AppointmentItem`); nothing else changes.

## 8. Tests

Server (PGlite, fake clock as in the base spec):
- status rules: confirm future ok / past 400; attended before the office day 400, on the day before the time ok, after ok;
  scheduled always ok; cancelled 409; non-author attendant 404; admin ok; idempotent repeat.
- reschedule resets attended/missed to scheduled and keeps confirmed.
- list filters: authorId honoured for admin / ignored for attendant; sectorId; status; q on name, title, phone digits;
  range bounds (inclusive from, exclusive to), range > 43 days 400, only one of from/to 400; cancelled included in range.
- summary counts on a fixed clock with rows on both sides of each bound, including a `TZ='Asia/Tokyo'` run.
- `officeDayRange` and `appointmentStatusProblem` unit tests in shared.

Web (vitest + Testing Library, api mocked):
- the page opens on Compromissos; `?aba=mensagens` opens messages.
- counters render and a click sets the preset; clicking again clears it.
- quick actions shown per §3.2 and call the status API.
- week view renders 7 days with today highlighted and chips in their day; ◀ ▶ change the range in the request.
- month view renders 42 cells and "+N".
- day grouping labels Hoje / Amanhã.

## 9. Review focus

1. Office-day math around midnight Cuiabá vs UTC (an appointment at 22:00 Cuiabá is the next UTC day).
2. An attendant passing `authorId` of someone else must still get only their own.
3. The week/month fetch with filters must not silently drop rows beyond the 500 limit without saying so (show
   "Mostrando os primeiros 500" when the response has 500 rows).
4. Status buttons must disappear for a cancelled appointment and for users without `canMark`.
5. Renaming `?situacao=` → `?periodo=` must not break the existing tab links/tests.
