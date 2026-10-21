import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto } from '@talk/shared';
import { APPOINTMENT_CANCELED } from '../../src/automation/appointments.js';
import { contacts, scheduledMessages } from '../../src/db/schema.js';
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

  it('a contact that lost its name refuses a recalculation that needs {nome}, but reminders already out never block it (controller ruling)', async () => {
    const a = await create();
    const [first, second] = await scheduled();
    await ctx.db.update(contacts).set({ name: null }).where(eq(contacts.id, a.contact.id));
    await setStatus(first!.id, 'sent');
    expect((await patch(a.id, { title: 'Perícia' })).statusCode).toBe(400); // the pending one would say "Olá, !"
    await setStatus(second!.id, 'sent');
    expect((await patch(a.id, { title: 'Perícia' })).statusCode).toBe(200);
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
