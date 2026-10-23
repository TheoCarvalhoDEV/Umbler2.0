// Office days must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { officeDayRange, type AppointmentDto } from '@talk/shared';
import { appointments } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { insertAppointment } from './seed.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
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

describe('GET /api/appointments/summary (spec section 5)', () => {
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
  it('at 23:30 Cuiaba "today" is still the Cuiaba day (Tokyo host, UTC already tomorrow)', async () => {
    const r = await seedBounds();
    ctx.clock.set(new Date('2026-10-15T03:30:00.000Z'));
    expect((await summary()).today).toBe(3);
    expect(await ids('/api/appointments?preset=tomorrow')).toEqual([r.tomorrowMidnight]);
  });
});
