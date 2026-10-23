# Controle de compromissos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Agenda's "Compromissos" into a control panel: each appointment gets a situation (Agendado / Confirmado / Compareceu / Faltou), the list gains filters, search, counters and day grouping, and there are week and month views.

**Architecture:** One new column `appointments.status` and one new endpoint `POST /api/appointments/:id/status`, checked by a shared rule (`appointmentStatusProblem`) that the web uses to decide which quick actions to show. `GET /api/appointments` gains optional filters, a date range and presets; `GET /api/appointments/summary` counts the presets with one SQL `count(*) filter (…)`. The web Agenda moves the Compromissos UI out of `ScheduledMessages.tsx` into `web/src/components/agenda/` (page shell, calendar views, pure date helpers).

**Tech Stack:** zod 4 + plain TS in `shared/`; Fastify 5, Drizzle 0.45, PGlite tests in `server/`; React 19, TanStack Query 5, Tailwind 4 recipes (`web/src/components/ui.ts`), Phosphor icons, vitest + Testing Library in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-23-controle-compromissos-design.md` (builds on `docs/superpowers/specs/2026-10-21-compromissos-design.md`). Read both.

## Global Constraints

- No new dependency (no calendar lib, no date lib). Week/month are CSS grid.
- Office timezone is `OFFICE_TIMEZONE` = America/Cuiaba for every "day"; never the host zone. Every new time test file starts with `process.env.TZ = 'Asia/Tokyo';` **before any import** (repo convention).
- Office-day math only through the shared helpers built on `officeLocalToIso` / `isoToOfficeLocal` (no DST rule assumed).
- Status values exactly `['scheduled', 'confirmed', 'attended', 'missed']`; labels "Agendado", "Confirmado", "Compareceu", "Faltou"; a cancelled one shows "Cancelado" and no status.
- Error copy, verbatim: "Este compromisso foi cancelado" (409), "O horário deste compromisso já passou", "Só dá para marcar presença a partir do dia do compromisso", "Período inválido".
- Who: an attendant sees/changes only appointments they created; an admin everyone's (`canManage` + `canSee`); anyone else 404. No change to visibility.
- No WS event for a status change; the Agenda keeps polling every 30 s (`refetchInterval: 30_000`).
- The status never touches reminders.
- UI copy pt-BR exactly as the spec; use `ui.ts` recipes and theme tokens only (no raw hex).
- Never print DB message bodies, phones or names in logs/commits.
- Commits: Conventional Commits, body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never switch branch, never push.

Commands (from the worktree root `C:/Users/assis/Desktop/umbler-talk-controle`):
- server tests: `npm test -w server -- test/automation/<file>.test.ts`
- web tests: `npm test -w web -- src/<path>.test.tsx`
- typecheck all: `npm run typecheck`
- migration: `npm run db:generate -w server -- --name situacao_compromissos`

## Review Focus

1. A notification toast for a failed scheduled message links to `/agendamentos?status=failed`; once the page opens on Compromissos by default, that link would land on the wrong tab. Expect it to still open Mensagens → Falharam (Task 6 changes the link to `?aba=mensagens&status=failed` and its test).
2. A search typed with `%` or `_` (e.g. "50%") must match literally, not "everything" (Task 3 test, reusing the existing `escapeLike`).
3. An appointment at 22:00–23:59 Cuiabá is already the next UTC/Tokyo day: it must count as "Hoje", be markable as presence that day, and sit in the right week/month cell (Tasks 1, 3, 4, 7 tests use such rows).
4. A search of only spaces must behave as "no search", not as a 400 or a match-all `%%` (Task 3 test; the web trims too).
5. A counter preset combined with a toolbar filter (e.g. "A confirmar" + Setor) must apply both, and the counters must follow the same Atendente/Setor/Busca filters as the list (Tasks 4 and 6 tests).

The spec's own §9 items are pinned too: Cuiabá midnight (Tasks 1/3/4), attendant `authorId` (Task 3), the 500 notice (Task 7), buttons hidden when cancelled / no `canMark` (Task 5), `?situacao=` → `?periodo=` (Task 6).

## Rulings on spec ambiguities

- **Search folding:** the repo already has an accent-insensitive fold (`translate(lower(col), FOLD_FROM, FOLD_TO)` + `foldText`, `server/src/inbox/queries.ts`). Reuse it instead of the spec's `lower()+ILIKE` fallback, so "jose" finds "José". Phone: digits only, contains, when the query has ≥ 4 digits.
- **Blank `q`:** trimmed; empty after trim = no search (not 400). Over 80 chars → 400.
- **Idempotent status:** setting the status it already has returns 200 without running the time rules (only the cancelled check runs). The shared function keeps the spec's signature; the server short-circuits.
- **`canMark`:** same expression as `canEdit` today (`!canceledAt && canManage && canSee`); kept as its own field per spec.
- **Precedence on `GET /api/appointments`:** `preset` > range (`from`+`to`) > `tab`. Author/sector/status/q filters always AND on top. Range validation (both or neither, `to > from`, ≤ 43 days) throws `badRequest('Período inválido')` in the service, because zod failures render the generic "Requisição inválida".
- **Counter preset outside Lista:** clicking a card always switches to Lista; `?filtro=` is ignored by Semana/Mês.
- **"Limpar filtros"** clears Atendente, Setor, Situação and Busca (not the counter preset, which its card clears).
- **Old `?situacao=`:** a value in `APPOINTMENT_TABS` is read as `periodo`; a value in `APPOINTMENT_STATUSES` is the status filter.
- **Week label across months/years:** "26 de out. – 1 de nov. de 2026", "28 de dez. de 2026 – 3 de jan. de 2027".
- **Pre-fill after 23:00 today:** the next whole hour leaves the day → no "+" for today.
- **Details dialog title:** "Detalhes do compromisso". `RowMenu` (spec §6.5 "optional") is skipped.
- **Counters while loading or on error:** the strip is not rendered.

## File map

- `shared/src/automation.ts` — status/preset constants, `APPOINTMENT_CANCELED` (moved here), office-day helpers, `appointmentStatusProblem`.
- `shared/src/index.ts` — re-exports; `AppointmentDto.status/canMark`; `AppointmentFiltersQuery`, `AppointmentListQuery`, `AppointmentSummaryDto`.
- `server/src/db/schema.ts`, `server/drizzle/0010_situacao_compromissos.sql` + meta — the column.
- `server/src/automation/appointments.ts` — status service, reschedule reset, filters/presets/range, summary.
- `server/src/automation/routes.ts` — query schemas, two routes.
- `server/src/inbox/queries.ts` — export the existing `escapeLike` and `folded`.
- `server/test/automation/appointment-control-rules.test.ts` (new), `appointments-status.test.ts` (new), `appointments-filters.test.ts` (new), `appointments-edit.test.ts` (add one test).
- `web/src/lib/api.ts` — client calls + query keys.
- `web/src/lib/hooks.ts` (new) — `useDebounced` moved out of `Inbox.tsx`.
- `web/src/components/conversation/Appointments.tsx` — badge, quick actions, `initialStartsAt`.
- `web/src/components/agenda/dates.ts` (+ `dates.test.ts`) — pure calendar/label helpers.
- `web/src/components/agenda/AppointmentsAgenda.tsx` — counters, toolbar, Lista view.
- `web/src/components/agenda/CalendarViews.tsx` — Semana, Mês, details dialog.
- `web/src/pages/ScheduledMessages.tsx` (+ test) — tab order/default, mounts `AppointmentsAgenda`.
- `web/src/components/layout/NotificationToasts.tsx` — failed-message link.

---

### Task 1: Shared contract and office-day helpers

**Files:**
- Modify: `shared/src/automation.ts` (append to the "Compromissos" section)
- Modify: `shared/src/index.ts` (value re-export list at lines 26–32; `AppointmentDto` at line 116)
- Modify: `server/src/automation/appointments.ts` (`APPOINTMENT_CANCELED` now imported from shared and re-exported, so `appointments-edit.test.ts` keeps importing it from there)
- Test: `server/test/automation/appointment-control-rules.test.ts` (new; shared has no test runner, shared tests live here like `appointment-rules.test.ts`)

**Interfaces:**
- Produces (all exported from `@talk/shared`):
  - `APPOINTMENT_STATUSES = ['scheduled','confirmed','attended','missed'] as const`, `type AppointmentStatus`
  - `APPOINTMENT_PRESETS = ['today','tomorrow','toConfirm','toMark'] as const`, `type AppointmentPreset`
  - `APPOINTMENT_RANGE_MAX_DAYS = 43`, `APPOINTMENT_RANGE_LIMIT = 500`
  - `APPOINTMENT_CANCELED = 'Este compromisso foi cancelado'`
  - `officeDateOf(d: Date): string` — the office date `'YYYY-MM-DD'`
  - `shiftOfficeDate(date: string, days: number): string` — calendar arithmetic on `'YYYY-MM-DD'`
  - `officeDayRange(date: string): { from: Date; to: Date }` — `[00:00 that day, 00:00 next day)` office time, via `officeLocalToIso`
  - `appointmentStatusProblem(a: { startsAt: Date; canceledAt: Date | null }, status: AppointmentStatus, now: Date): string | null`
  - in `index.ts`: `AppointmentDto` gains `status: AppointmentStatus; canMark: boolean`;
    `interface AppointmentFiltersQuery { authorId?: string; sectorId?: string; q?: string }`;
    `interface AppointmentListQuery extends AppointmentFiltersQuery { tab?: AppointmentTab; from?: string; to?: string; status?: AppointmentStatus; preset?: AppointmentPreset }`;
    `interface AppointmentSummaryDto { today: number; tomorrow: number; toConfirm: number; toMark: number }`

- [ ] **Step 1: Write the failing test** `server/test/automation/appointment-control-rules.test.ts`

```ts
// Office days are Cuiabá days: must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import { describe, expect, it } from 'vitest';
import { APPOINTMENT_CANCELED, appointmentStatusProblem, officeDateOf, officeDayRange, shiftOfficeDate } from '@talk/shared';

const at = (iso: string) => new Date(iso);
const PAST = 'O horário deste compromisso já passou';
const NOT_YET = 'Só dá para marcar presença a partir do dia do compromisso';

describe('office days (spec 2026-10-23 controle §5)', () => {
  it('officeDateOf reads the Cuiabá date, not the UTC or host one (Review Focus 3)', () => {
    expect(officeDateOf(at('2026-10-15T03:59:00.000Z'))).toBe('2026-10-14'); // 23:59 in Cuiabá, 12:59 on the 15th in Tokyo
    expect(officeDateOf(at('2026-10-15T04:00:00.000Z'))).toBe('2026-10-15');
  });
  it('shiftOfficeDate crosses months and years', () => {
    expect(shiftOfficeDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftOfficeDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftOfficeDate('2027-02-28', 1)).toBe('2027-03-01');
    expect(shiftOfficeDate('2026-10-19', 42)).toBe('2026-11-30');
  });
  it('officeDayRange is [00:00, next 00:00) in Cuiabá', () => {
    expect(officeDayRange('2026-10-14')).toEqual({ from: at('2026-10-14T04:00:00.000Z'), to: at('2026-10-15T04:00:00.000Z') });
    expect(officeDayRange('2026-12-31')).toEqual({ from: at('2026-12-31T04:00:00.000Z'), to: at('2027-01-01T04:00:00.000Z') });
  });
});

describe('appointmentStatusProblem (spec §3.2)', () => {
  const now = at('2026-10-14T13:00:00.000Z'); // 09:00 in Cuiabá
  const appt = (startsAt: string, canceledAt: Date | null = null) => ({ startsAt: at(startsAt), canceledAt });

  it('a cancelled appointment refuses every status', () => {
    for (const s of ['scheduled', 'confirmed', 'attended', 'missed'] as const) {
      expect(appointmentStatusProblem(appt('2026-10-20T13:00:00.000Z', now), s, now)).toBe(APPOINTMENT_CANCELED);
    }
  });
  it('confirmed only while the time is ahead', () => {
    expect(appointmentStatusProblem(appt('2026-10-14T13:01:00.000Z'), 'confirmed', now)).toBeNull();
    expect(appointmentStatusProblem(appt('2026-10-14T13:00:00.000Z'), 'confirmed', now)).toBe(PAST);
    expect(appointmentStatusProblem(appt('2026-10-13T13:00:00.000Z'), 'confirmed', now)).toBe(PAST);
  });
  it('attended / missed from the office day on, also before the time; never on a later day', () => {
    for (const s of ['attended', 'missed'] as const) {
      expect(appointmentStatusProblem(appt('2026-10-15T03:30:00.000Z'), s, now)).toBeNull(); // 23:30 today in Cuiabá
      expect(appointmentStatusProblem(appt('2026-10-13T13:00:00.000Z'), s, now)).toBeNull();
      expect(appointmentStatusProblem(appt('2026-10-15T04:00:00.000Z'), s, now)).toBe(NOT_YET); // 00:00 tomorrow
    }
  });
  it('scheduled is always allowed', () => {
    expect(appointmentStatusProblem(appt('2026-10-13T13:00:00.000Z'), 'scheduled', now)).toBeNull();
    expect(appointmentStatusProblem(appt('2026-10-20T13:00:00.000Z'), 'scheduled', now)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/automation/appointment-control-rules.test.ts`
Expected: FAIL (`appointmentStatusProblem is not a function` / not exported).

- [ ] **Step 3: Implement in `shared/src/automation.ts`**, re-export the values from `shared/src/index.ts`, extend `AppointmentDto` and add the three query/summary interfaces in `index.ts` (import `AppointmentStatus`, `AppointmentPreset`, `AppointmentTab` types from `./automation.js`).
  - `officeDateOf(d)` = `isoToOfficeLocal(d.toISOString()).slice(0, 10)`.
  - `shiftOfficeDate` uses `Date.UTC` arithmetic on the parts (no host zone).
  - `officeDayRange(date)` = `{ from: new Date(officeLocalToIso(`${date}T00:00`)!), to: new Date(officeLocalToIso(`${shiftOfficeDate(date, 1)}T00:00`)!) }`.
  - `appointmentStatusProblem`: cancelled → `APPOINTMENT_CANCELED`; `confirmed` and `startsAt <= now` → PAST copy; `attended`/`missed` and `officeDateOf(startsAt) > officeDateOf(now)` (string compare) → NOT_YET copy; else null.
  - In `server/src/automation/appointments.ts` replace the local `export const APPOINTMENT_CANCELED = …` with an import from `@talk/shared` plus `export { APPOINTMENT_CANCELED };`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w server -- test/automation/appointment-control-rules.test.ts test/automation/appointments-edit.test.ts`
Expected: PASS. (`npm run typecheck` fails on `AppointmentDto` until Task 2 — expected; do not "fix" it here.)

- [ ] **Step 5: Commit**

```bash
git add shared/src/automation.ts shared/src/index.ts server/src/automation/appointments.ts server/test/automation/appointment-control-rules.test.ts
git commit -m "feat(shared): situação de compromisso, dias do escritório e regra de marcação

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Status column, `POST /api/appointments/:id/status`, reschedule reset

**Files:**
- Modify: `server/src/db/schema.ts:375-390` (`appointments` table)
- Create (generated): `server/drizzle/0010_situacao_compromissos.sql`, `server/drizzle/meta/0010_snapshot.json`, entry in `server/drizzle/meta/_journal.json`
- Modify: `server/src/automation/appointments.ts` (`appointmentDtos`, `updateAppointment`, new `setAppointmentStatus`)
- Modify: `server/src/automation/routes.ts`
- Modify (fixtures only, to keep typecheck green): `web/src/components/conversation/Appointments.test.tsx` and `web/src/pages/ScheduledMessages.test.tsx` — the `appointment()` factories gain `status: 'scheduled', canMark: true`.
- Test: `server/test/automation/appointments-status.test.ts` (new), `server/test/automation/appointments-edit.test.ts` (one new `it`)

**Interfaces:**
- Consumes: Task 1 `AppointmentStatus`, `APPOINTMENT_STATUSES`, `appointmentStatusProblem`, `APPOINTMENT_CANCELED`.
- Produces: `setAppointmentStatus(ctx: AppCtx, user: AuthUser, id: string, status: AppointmentStatus): Promise<AppointmentDto>`; route `POST /api/appointments/:id/status` body `{ status }`; every `AppointmentDto` now carries `status` and `canMark`. `insertAppointment` (test seed) accepts `status` through its `Partial<AppointmentInsert>`.

- [ ] **Step 1: Write the failing tests**

`server/test/automation/appointments-status.test.ts` — copy the `beforeEach`/`afterEach`, constants (`MIN`, `HOUR`, `DAY`) and `dateIn` from `appointments-api.test.ts` (Ana = `s.agentA`, chat in sector A, fake clock 2026-10-14T13:00Z = 09:00 Cuiabá), with `process.env.TZ = 'Asia/Tokyo'` first. Then:

```ts
const mark = (id: string, status: string, headers = ana) =>
  app.inject({ method: 'POST', url: `/api/appointments/${id}/status`, headers, payload: { status } });
const statusOf = async (id: string) => (await ctx.db.select().from(appointments).where(eq(appointments.id, id)))[0]!.status;
const err = (r: { statusCode: number; json: () => { error: string } }) => [r.statusCode, r.json().error];

describe('POST /api/appointments/:id/status (spec 2026-10-23 controle §3)', () => {
  it('confirms a future appointment and returns the DTO; a past one is refused', async () => {
    const future = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    const res = await mark(future.id, 'confirmed');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: future.id, status: 'confirmed', canMark: true, canEdit: true });
    expect(await statusOf(future.id)).toBe('confirmed');
    const past = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-HOUR) });
    expect(err(await mark(past.id, 'confirmed'))).toEqual([400, 'O horário deste compromisso já passou']);
  });

  it('presence from the office day on: later today ok, 22:00 Cuiabá today ok, tomorrow 400, the past ok', async () => {
    const later = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: new Date('2026-10-14T20:00:00.000Z') });
    const lateNight = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: new Date('2026-10-15T02:00:00.000Z') });
    const tomorrow = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: new Date('2026-10-15T14:00:00.000Z') });
    const past = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-2 * DAY) });
    expect((await mark(later.id, 'attended')).statusCode).toBe(200);
    expect((await mark(lateNight.id, 'missed')).statusCode).toBe(200);
    expect(err(await mark(tomorrow.id, 'attended'))).toEqual([400, 'Só dá para marcar presença a partir do dia do compromisso']);
    expect((await mark(past.id, 'missed')).json().status).toBe('missed');
    expect((await mark(past.id, 'scheduled')).json().status).toBe('scheduled'); // undo, always allowed
  });

  it('repeating the current status is 200 and changes nothing, even when its rule no longer holds', async () => {
    const past = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-HOUR), status: 'confirmed' });
    expect((await mark(past.id, 'confirmed')).statusCode).toBe(200);
    expect(await statusOf(past.id)).toBe('confirmed');
  });

  it('cancelled 409, another attendant 404, an admin may, a bad value 400; no event, no publish', async () => {
    const mine = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    const canceled = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY), canceledAt: dateIn(0) });
    expect(err(await mark(canceled.id, 'scheduled'))).toEqual([409, APPOINTMENT_CANCELED]);
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await mark(mine.id, 'confirmed', bruno)).statusCode).toBe(404);
    await enableSeeAll(ctx, s.admin); // an admin without "ver todos" and no sector cannot see Ana's chat (canSee)
    const admin = (await loginAs(app, s.admin.email)).headers;
    expect((await mark(mine.id, 'confirmed', admin)).statusCode).toBe(200);
    expect((await mark(mine.id, 'done')).statusCode).toBe(400);
    expect(await eventsOf(ctx, chatId)).toEqual([]);
    expect(ctx.hub.events).toEqual([]);
  });

  it('the DTO: canMark false once cancelled; new rows start as scheduled', async () => {
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY), canceledAt: dateIn(0) });
    const list = async (tab: string) => (await app.inject({ method: 'GET', url: `/api/appointments?tab=${tab}`, headers: ana })).json();
    expect((await list('upcoming'))[0]).toMatchObject({ status: 'scheduled', canMark: true });
    expect((await list('canceled'))[0]).toMatchObject({ canMark: false, canEdit: false });
  });
});
```

(If `ctx.hub.events` already holds entries from the seed, assert on its length before/after instead.)

Add to `server/test/automation/appointments-edit.test.ts` (uses its `create`, `patch`, `after`, `DAY`):

```ts
it('moving the time resets Compareceu/Faltou to Agendado and keeps Confirmado; a title change keeps it (spec 2026-10-23 controle §3.4)', async () => {
  const a = await create();
  const setDb = (status: 'confirmed' | 'attended' | 'missed') => ctx.db.update(appointments).set({ status }).where(eq(appointments.id, a.id));
  await setDb('missed');
  expect((await patch(a.id, { startsAt: after(4 * DAY) })).json().status).toBe('scheduled');
  await setDb('confirmed');
  expect((await patch(a.id, { startsAt: after(5 * DAY) })).json().status).toBe('confirmed');
  await setDb('attended');
  expect((await patch(a.id, { title: 'Perícia' })).json().status).toBe('attended');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/automation/appointments-status.test.ts test/automation/appointments-edit.test.ts`
Expected: FAIL (column `status` does not exist / 404 route).

- [ ] **Step 3: Add the column and generate the migration**

In `appointments`: `status: text('status').$type<AppointmentStatus>().notNull().default('scheduled'),` (import the type from `@talk/shared` with the others at line 19). Then run `npm run db:generate -w server -- --name situacao_compromissos`.
Expected: `server/drizzle/0010_situacao_compromissos.sql` containing exactly `ALTER TABLE "appointments" ADD COLUMN "status" text DEFAULT 'scheduled' NOT NULL;`, plus `meta/0010_snapshot.json` and a journal entry `idx: 10`. If drizzle-kit asks anything interactive, stop and report.

- [ ] **Step 4: Implement the service and route**
  - `appointmentDtos`: add `status: a.status` and `canMark` (same expression as `canEdit`; compute once, assign to both).
  - `setAppointmentStatus`: `manageableContact` (404/409), then a transaction that locks the row `for('update')`, throws `conflict(APPOINTMENT_CANCELED)` if cancelled, returns early when `locked.status === status`, else `appointmentStatusProblem(locked, status, ctx.botRuntime.now())` → `badRequest(problem)`, else updates `status`. No `addEvent`, no `publishChat`. Return `dtoOf(...)`.
  - `updateAppointment`: in the existing `.set({...})`, when `moved` and `locked.status` is `attended` or `missed`, also set `status: 'scheduled'`.
  - `routes.ts`: `app.post('/api/appointments/:id/status', …)` with body `z.object({ status: z.enum(APPOINTMENT_STATUSES) })`.
  - Add `status: 'scheduled', canMark: true` to the two web `appointment()` fixture factories.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w server -- test/automation` then `npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/src/automation/appointments.ts server/src/automation/routes.ts server/test/automation/appointments-status.test.ts server/test/automation/appointments-edit.test.ts web/src/components/conversation/Appointments.test.tsx web/src/pages/ScheduledMessages.test.tsx
git commit -m "feat(server): situação do compromisso (POST /status) e remarcar volta para Agendado

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: List filters, search, range and presets

**Files:**
- Modify: `server/src/inbox/queries.ts:62,338` — `export` the existing `escapeLike` and `folded` (no other change)
- Modify: `server/src/automation/appointments.ts` (`appointmentDtos` gets a `limit` param; `listAppointments` new signature; new `filtersWhere`, `presetWhere`)
- Modify: `server/src/automation/routes.ts` (`appointmentQuery`)
- Test: `server/test/automation/appointments-filters.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `APPOINTMENT_PRESETS`, `APPOINTMENT_RANGE_MAX_DAYS`, `APPOINTMENT_RANGE_LIMIT`, `officeDateOf`, `shiftOfficeDate`, `officeDayRange`; Task 2 `appointments.status`.
- Produces (in `appointments.ts`, used by Task 4):
  - `export interface AppointmentFilters { authorId?: string; sectorId?: string; q?: string }`
  - `export interface AppointmentListParams extends AppointmentFilters { tab: AppointmentTab; from?: Date; to?: Date; status?: AppointmentStatus; preset?: AppointmentPreset }`
  - `function filtersWhere(user: AuthUser, f: AppointmentFilters): SQL | undefined` — author (admin: `f.authorId` if given; attendant: always `user.id`), `eq(chats.sectorId, …)`, and `q`: `or(like(folded(contacts.name), p), like(folded(appointments.title), p), digits.length >= 4 ? like(contacts.phone, %digits%) : undefined)` with `p = %${escapeLike(foldText(q))}%`; blank q = no condition.
  - `function presetWhere(preset: AppointmentPreset, now: Date): SQL` — all `isNull(canceledAt)`; `today`/`tomorrow` = `officeDayRange(shiftOfficeDate(officeDateOf(now), 0 | 1))`; `toConfirm` = `status = 'scheduled'` and `now ≤ starts_at < now + 7 d`; `toMark` = `status in ('scheduled','confirmed')` and `now − 60 d ≤ starts_at < now`. Constants `TO_CONFIRM_MS = 7 * DAY`, `TO_MARK_MS = 60 * DAY` with a `// ponytail:` note copied from spec §5.
  - `listAppointments(ctx: AppCtx, user: AuthUser, p: AppointmentListParams): Promise<AppointmentDto[]>`; route accepts `tab, from, to, authorId, sectorId, status, q, preset` (`q: z.string().trim().max(80).optional()`).

- [ ] **Step 1: Write the failing test** `server/test/automation/appointments-filters.test.ts`

Header as in Task 2 (TZ Tokyo, same `beforeEach` creating Ana's chat "Maria Cliente" / `5565999999999` in sector A), plus `admin` and `bruno` headers and Bruno's chat:

```ts
let admin: Record<string, string>;
let bruno: Record<string, string>;
let brunoChat: string;
beforeEach(async () => {
  admin = (await loginAs(app, s.admin.email)).headers;
  bruno = (await loginAs(app, s.agentB.email)).headers;
  ({ chatId: brunoChat } = await seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id, name: 'José Ávila', phone: '5565988887777',
  }));
});
const ids = async (url: string, headers = admin) => {
  const r = await app.inject({ method: 'GET', url, headers });
  expect(r.statusCode).toBe(200);
  return (r.json() as AppointmentDto[]).map((a) => a.id);
};
const status = async (url: string, headers = admin) => {
  const r = await app.inject({ method: 'GET', url, headers });
  return [r.statusCode, r.json().error];
};
const at = (iso: string) => new Date(iso);
const add = (startsAt: Date, over: object = {}) =>
  insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt, ...over }).then((a) => a.id);

/** Rows on both sides of every bound; the clock is 2026-10-14T13:00Z (09:00 in Cuiabá). Reused by the summary tests (Task 4). */
async function seedBounds() {
  return {
    todayEarly: await add(at('2026-10-14T05:00:00.000Z')),                        // 01:00 today, past
    todayLate: await add(at('2026-10-15T03:30:00.000Z')),                         // 23:30 today (already the 15th in UTC)
    tomorrowMidnight: await add(at('2026-10-15T04:00:00.000Z'), { status: 'confirmed' }),
    yesterdayLate: await add(at('2026-10-14T03:59:00.000Z'), { status: 'attended' }),
    canceledToday: await add(at('2026-10-14T15:00:00.000Z'), { canceledAt: dateIn(0) }),
    confirmEdge: await add(dateIn(7 * DAY - MIN)),
    confirmOut: await add(dateIn(7 * DAY)),
    markEdge: await add(dateIn(-60 * DAY), { status: 'confirmed' }),
    markOut: await add(dateIn(-60 * DAY - MIN)),
    brunoToday: await insertAppointment(ctx, {
      chatId: brunoChat, authorId: s.agentB.id, startsAt: at('2026-10-14T20:00:00.000Z'), status: 'missed', title: 'Perícia',
    }).then((a) => a.id),
  };
}

describe('GET /api/appointments filters (spec 2026-10-23 controle §4)', () => {
  it('authorId is honoured for an admin and ignored for an attendant (spec Review focus 2)', async () => {
    const mine = await add(dateIn(DAY));
    const brunos = await insertAppointment(ctx, { chatId: brunoChat, authorId: s.agentB.id, startsAt: dateIn(2 * DAY) }).then((a) => a.id);
    expect(await ids(`/api/appointments?authorId=${s.agentB.id}`)).toEqual([brunos]);
    expect(await ids(`/api/appointments?authorId=${s.agentB.id}`, ana)).toEqual([mine]);
    expect(await ids(`/api/appointments?sectorId=${s.sectorB}`)).toEqual([brunos]);
    expect(await ids(`/api/appointments?sectorId=${s.sectorB}`, bruno)).toEqual([brunos]);
  });

  it('status filters and never lists a cancelled one', async () => {
    const confirmed = await add(dateIn(DAY), { status: 'confirmed' });
    await add(dateIn(DAY));
    await add(dateIn(DAY), { status: 'confirmed', canceledAt: dateIn(0) });
    expect(await ids('/api/appointments?status=confirmed')).toEqual([confirmed]);
    expect(await ids('/api/appointments?tab=canceled&status=confirmed')).toEqual([]);
  });

  it('q: name and title without case or accents, phone digits from 4, wildcards literal, blank = none, > 80 → 400 (Review Focus 2, 4)', async () => {
    const maria = await add(dateIn(DAY), { title: 'Audiência' });
    const jose = await insertAppointment(ctx, { chatId: brunoChat, authorId: s.agentB.id, startsAt: dateIn(2 * DAY), title: 'Perícia 50%' }).then((a) => a.id);
    expect(await ids('/api/appointments?q=MARIA')).toEqual([maria]);
    expect(await ids('/api/appointments?q=jose')).toEqual([jose]);
    expect(await ids('/api/appointments?q=PERICIA')).toEqual([jose]);
    expect(await ids(`/api/appointments?q=${encodeURIComponent('8888-7777')}`)).toEqual([jose]);
    expect(await ids('/api/appointments?q=99')).toEqual([]); // under 4 digits: no phone match
    expect(await ids(`/api/appointments?q=${encodeURIComponent('50%')}`)).toEqual([jose]);
    expect(await ids(`/api/appointments?q=${encodeURIComponent('%')}`)).toEqual([jose]);
    expect(await ids(`/api/appointments?q=${encodeURIComponent('_')}`)).toEqual([]);
    expect(await ids(`/api/appointments?q=${encodeURIComponent('   ')}`)).toEqual([maria, jose]);
    expect((await status(`/api/appointments?q=${'x'.repeat(81)}`))[0]).toBe(400);
  });

  it('range: from inclusive, to exclusive, cancelled included, ascending, tab ignored; bad ranges → "Período inválido"', async () => {
    const { from, to } = officeDayRange('2026-10-15');
    const first = await add(from);
    const canceled = await add(new Date(from.getTime() + HOUR), { canceledAt: dateIn(0) });
    await add(to);
    const q = (f: Date, t: Date) => `from=${f.toISOString()}&to=${t.toISOString()}`;
    expect(await ids(`/api/appointments?tab=past&${q(from, to)}`)).toEqual([first, canceled]);
    const day43 = new Date(from.getTime() + 43 * DAY);
    expect((await status(`/api/appointments?${q(from, day43)}`))[0]).toBe(200);
    for (const bad of [q(from, new Date(day43.getTime() + 1)), q(from, from), `from=${from.toISOString()}`, `to=${to.toISOString()}`]) {
      expect(await status(`/api/appointments?${bad}`)).toEqual([400, 'Período inválido']);
    }
  });

  it('a range returns up to 500, a tab up to 100', async () => {
    await ctx.db.insert(appointments).values(
      Array.from({ length: 501 }, (_, i) => ({ chatId, authorId: s.agentA.id, title: 'Audiência', startsAt: dateIn(HOUR + i * MIN) })),
    );
    const { from } = officeDayRange('2026-10-14');
    expect(await ids(`/api/appointments?from=${from.toISOString()}&to=${dateIn(30 * DAY).toISOString()}`)).toHaveLength(500);
    expect(await ids('/api/appointments')).toHaveLength(100);
  });

  it('presets apply the counter rules in their order, and AND with the filters (Review Focus 3, 5)', async () => {
    const r = await seedBounds();
    expect(await ids('/api/appointments?preset=today')).toEqual([r.todayEarly, r.brunoToday, r.todayLate]);
    expect(await ids('/api/appointments?preset=tomorrow')).toEqual([r.tomorrowMidnight]);
    expect(await ids('/api/appointments?preset=toConfirm')).toEqual([r.todayLate, r.confirmEdge]);
    expect(await ids('/api/appointments?preset=toMark')).toEqual([r.todayEarly, r.markEdge]); // newest first
    expect(await ids(`/api/appointments?preset=today&sectorId=${s.sectorB}`)).toEqual([r.brunoToday]);
    expect(await ids('/api/appointments?preset=today', ana)).toEqual([r.todayEarly, r.todayLate]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/automation/appointments-filters.test.ts`
Expected: FAIL (filters ignored / range not validated).

- [ ] **Step 3: Implement**
  - `appointmentDtos(db, user, where, order, limit = LIST_LIMIT)`.
  - `listAppointments`: validate the range first (both-or-neither, `to > from`, `to − from ≤ APPOINTMENT_RANGE_MAX_DAYS × DAY`, else `badRequest('Período inválido')`). `when` = `presetWhere` if `preset`, else `gte/lt` on `starts_at` if range, else the existing tab condition. Status filter = `and(eq(appointments.status, p.status), isNull(appointments.canceledAt))`. Order: ascending for range, `upcoming`, `today`, `tomorrow`, `toConfirm`; descending for `past`, `canceled`, `toMark`. Limit `APPOINTMENT_RANGE_LIMIT` for a range, else 100.
  - Route: parse, then `listAppointments(ctx, req.user, { ...q, from: q.from ? new Date(q.from) : undefined, to: …, q: q.q || undefined })`. Keep `tab` default `'upcoming'`.

- [ ] **Step 4: Run tests**

Run: `npm test -w server -- test/automation` and `npm run typecheck`
Expected: PASS (the existing "Agenda tab … up to 100" test in `appointments-api.test.ts` still passes).

- [ ] **Step 5: Commit**

```bash
git add server/src/inbox/queries.ts server/src/automation/appointments.ts server/src/automation/routes.ts server/test/automation/appointments-filters.test.ts
git commit -m "feat(server): filtros, busca, período e atalhos na lista de compromissos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Counters — `GET /api/appointments/summary`

**Files:**
- Modify: `server/src/automation/appointments.ts` (new `appointmentSummary`)
- Modify: `server/src/automation/routes.ts`
- Test: `server/test/automation/appointments-filters.test.ts` (new `describe`, reuses `seedBounds`)

**Interfaces:**
- Consumes: Task 3 `filtersWhere`, `presetWhere`, `AppointmentFilters`; Task 1 `AppointmentSummaryDto`.
- Produces: `appointmentSummary(ctx: AppCtx, user: AuthUser, f: AppointmentFilters): Promise<AppointmentSummaryDto>`; route `GET /api/appointments/summary?authorId&sectorId&q` (same zod fields as the list; `status`, range, `tab`, `preset` not accepted — extra keys are ignored by zod's default strip).

- [ ] **Step 1: Write the failing test** (append to `appointments-filters.test.ts`)

```ts
describe('GET /api/appointments/summary (spec §5)', () => {
  const summary = async (qs = '', headers = admin) => {
    const r = await app.inject({ method: 'GET', url: `/api/appointments/summary${qs}`, headers });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  it('counts each bound once, without cancelled ones, with the same filters as the list (Review Focus 3, 5)', async () => {
    await seedBounds();
    expect(await summary()).toEqual({ today: 3, tomorrow: 1, toConfirm: 2, toMark: 2 });
    expect(await summary('', ana)).toEqual({ today: 2, tomorrow: 1, toConfirm: 2, toMark: 2 });
    expect(await summary(`?authorId=${s.agentB.id}`, ana)).toEqual({ today: 2, tomorrow: 1, toConfirm: 2, toMark: 2 });
    expect(await summary(`?authorId=${s.agentB.id}`)).toEqual({ today: 1, tomorrow: 0, toConfirm: 0, toMark: 0 });
    expect(await summary(`?sectorId=${s.sectorB}`)).toEqual({ today: 1, tomorrow: 0, toConfirm: 0, toMark: 0 });
    expect(await summary('?q=maria')).toEqual({ today: 2, tomorrow: 1, toConfirm: 2, toMark: 2 });
  });
  it('at 23:30 Cuiabá "today" is still the Cuiabá day (Tokyo host, UTC already tomorrow)', async () => {
    const r = await seedBounds();
    ctx.clock.set(new Date('2026-10-15T03:30:00.000Z'));
    expect((await summary()).today).toBe(3);
    expect(await ids('/api/appointments?preset=tomorrow')).toEqual([r.tomorrowMidnight]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/automation/appointments-filters.test.ts`
Expected: FAIL (404 on `/summary`).

- [ ] **Step 3: Implement** one query over `appointments ⋈ chats ⋈ contacts` with `where(filtersWhere(user, f))` and four columns `sql<number>\`count(*) filter (where ${presetWhere(k, now)})\`.mapWith(Number)`, `now = ctx.botRuntime.now()`. Register `app.get('/api/appointments/summary', …)`.

- [ ] **Step 4: Run tests**

Run: `npm test -w server -- test/automation` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/automation/appointments.ts server/src/automation/routes.ts server/test/automation/appointments-filters.test.ts
git commit -m "feat(server): contadores da agenda (hoje, amanhã, a confirmar, presença a marcar)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
