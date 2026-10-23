// Office days must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPOINTMENT_CANCELED } from '../../src/automation/appointments.js';
import { appointments } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { insertAppointment } from './seed.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let ana: Record<string, string>;
let chatId: string;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z (09:00 in Cuiabá)
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

const dateIn = (ms: number) => new Date(ctx.clock.now().getTime() + ms);
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
    const published = ctx.hub.events.length;
    expect(err(await mark(canceled.id, 'scheduled'))).toEqual([409, APPOINTMENT_CANCELED]);
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await mark(mine.id, 'confirmed', bruno)).statusCode).toBe(404);
    await enableSeeAll(ctx, s.admin); // an admin without "ver todos" and no sector cannot see Ana's chat (canSee)
    const admin = (await loginAs(app, s.admin.email)).headers;
    expect((await mark(mine.id, 'confirmed', admin)).statusCode).toBe(200);
    expect((await mark(mine.id, 'done')).statusCode).toBe(400);
    expect(await eventsOf(ctx, chatId)).toEqual([]);
    expect(ctx.hub.events.length).toBe(published);
  });

  it('the DTO: canMark false once cancelled; new rows start as scheduled', async () => {
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY), canceledAt: dateIn(0) });
    const list = async (tab: string) => (await app.inject({ method: 'GET', url: `/api/appointments?tab=${tab}`, headers: ana })).json();
    expect((await list('upcoming'))[0]).toMatchObject({ status: 'scheduled', canMark: true });
    expect((await list('canceled'))[0]).toMatchObject({ canMark: false, canEdit: false });
  });
});
