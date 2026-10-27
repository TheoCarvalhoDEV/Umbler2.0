import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { officeLocalToIso, type ReportDto } from '@talk/shared';
import { chatEvents, chats, messages } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { newContact } from '../inbox/fixtures.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});

afterEach(async () => {
  await app.close();
});

/** Office (Cuiabá) wall time → instant. */
const at = (local: string) => new Date(officeLocalToIso(local)!);

async function chat(f: { sectorId: string; created: string; closed?: string; waiting?: boolean; history?: boolean }): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(chats).values({
    id, contactId: await newContact(ctx), channelId: seed.channelId, sectorId: f.sectorId, state: f.closed ? 'closed' : 'open',
    waiting: f.waiting ?? false, createdAt: at(f.created), closedAt: f.closed ? at(f.closed) : null, history: f.history ?? false,
  });
  return id;
}

/** [office time, 'in' | author id | 'system' | 'note:<author id>'] */
async function msgs(chatId: string, list: Array<[string, string]>) {
  await ctx.db.insert(messages).values(
    list.map(([when, who]) => {
      const note = who.startsWith('note:');
      const authorId = note ? who.slice(5) : who === 'in' || who === 'system' ? null : who;
      return {
        chatId, channelId: seed.channelId, direction: who === 'in' ? ('in' as const) : ('out' as const), kind: note ? ('note' as const) : ('text' as const),
        body: 'x', authorId, status: 'sent' as const, sentAt: at(when),
      };
    }),
  );
}

async function closedBy(chatId: string, authorId: string, when: string) {
  await ctx.db.insert(chatEvents).values({ chatId, kind: 'closed', authorId, createdAt: at(when) });
}

async function report(email: string, query: string) {
  const { headers } = await loginAs(app, email);
  return app.inject({ method: 'GET', url: `/api/reports?${query}`, headers });
}

it('counts the period: new and finalized chats, first replies, reply waits, sectors, attendants and peak hours', async () => {
  const { agentA, agentB, admin, sectorA, sectorB, defaultSector } = seed;
  // Tuesday 20: the client writes, triage answers, the client picks, Ana replies (first reply 10 min, wait 8 min); later 30 min.
  const c1 = await chat({ sectorId: sectorA, created: '2026-10-20T09:00', closed: '2026-10-21T10:00' });
  await msgs(c1, [
    ['2026-10-20T09:00', 'in'], ['2026-10-20T09:01', 'system'], ['2026-10-20T09:02', 'in'], ['2026-10-20T09:10', agentA.id],
    ['2026-10-20T09:11', `note:${agentA.id}`], ['2026-10-20T10:00', 'in'], ['2026-10-20T10:01', 'in'], ['2026-10-20T10:30', agentA.id],
  ]);
  await closedBy(c1, agentA.id, '2026-10-21T10:00');
  // Thursday 22: still open and waiting; Bruno replied after 30 min.
  const c2 = await chat({ sectorId: sectorB, created: '2026-10-22T14:00', waiting: true });
  await msgs(c2, [['2026-10-22T14:00', 'in'], ['2026-10-22T14:30', agentB.id]]);
  // Friday 23: started by the office, so no first reply; one wait of 1 min.
  const c3 = await chat({ sectorId: defaultSector, created: '2026-10-23T08:00' });
  await msgs(c3, [['2026-10-23T08:00', agentA.id], ['2026-10-23T08:05', 'in'], ['2026-10-23T08:06', agentA.id]]);
  // Older chat finalized in the period by the admin; a phone-history chat and a chat after the period stay out.
  const old = await chat({ sectorId: sectorA, created: '2026-10-10T09:00', closed: '2026-10-24T12:00' });
  await closedBy(old, admin.id, '2026-10-24T12:00');
  const hist = await chat({ sectorId: sectorA, created: '2026-10-21T08:00', closed: '2026-10-21T08:00', history: true });
  await msgs(hist, [['2026-10-21T08:00', 'in'], ['2026-10-21T08:01', agentA.id]]);
  await chat({ sectorId: sectorA, created: '2026-10-26T09:00', closed: '2026-10-26T10:00' });

  const res = await report(admin.email, 'from=2026-10-19&to=2026-10-25');
  expect(res.statusCode).toBe(200);
  const r = res.json<ReportDto>();
  expect(r.totals).toEqual({
    newChats: 3, closedChats: 2, openNow: 2, waitingNow: 1, firstResponseSec: 1200, within15Pct: 50, replySec: 1140, botChats: 0,
  });
  expect(r.days).toEqual([
    { day: '2026-10-19', newChats: 0, closedChats: 0 },
    { day: '2026-10-20', newChats: 1, closedChats: 0 },
    { day: '2026-10-21', newChats: 0, closedChats: 1 },
    { day: '2026-10-22', newChats: 1, closedChats: 0 },
    { day: '2026-10-23', newChats: 1, closedChats: 0 },
    { day: '2026-10-24', newChats: 0, closedChats: 1 },
    { day: '2026-10-25', newChats: 0, closedChats: 0 },
  ]);
  expect(r.sectors).toEqual([
    { id: defaultSector, name: 'Atendimento', newChats: 1, closedChats: 0, firstResponseSec: null },
    { id: sectorA, name: 'Financeiro', newChats: 1, closedChats: 2, firstResponseSec: 600 },
    { id: sectorB, name: 'Jurídico', newChats: 1, closedChats: 0, firstResponseSec: 1800 },
  ]);
  expect(r.agents).toEqual([
    { id: agentA.id, name: agentA.name, chats: 2, closedChats: 1, messages: 4, firstResponseSec: 600 },
    { id: agentB.id, name: agentB.name, chats: 1, closedChats: 0, messages: 1, firstResponseSec: 1800 },
    { id: admin.id, name: admin.name, chats: 0, closedChats: 1, messages: 0, firstResponseSec: null },
  ]);
  expect(r.peak).toHaveLength(7);
  expect(r.peak[1]![9]).toBe(2); // Tuesday 09h
  expect(r.peak[1]![10]).toBe(2);
  expect(r.peak[3]![14]).toBe(1); // Thursday 14h
  expect(r.peak[4]![8]).toBe(1); // Friday 08h
  expect(r.peak.flat().reduce((a, b) => a + b, 0)).toBe(6);
});

it('an empty period has zeros and no times', async () => {
  const r = (await report(seed.admin.email, 'from=2026-10-27&to=2026-10-27')).json<ReportDto>();
  expect(r.totals).toMatchObject({ newChats: 0, firstResponseSec: null, within15Pct: null, replySec: null });
  expect(r.days).toEqual([{ day: '2026-10-27', newChats: 0, closedChats: 0 }]);
  expect(r.agents).toEqual([]);
});

it('only admins see reports, and the period must be valid', async () => {
  expect((await report(seed.agentA.email, 'from=2026-10-19&to=2026-10-25')).statusCode).toBe(403);
  expect((await report(seed.admin.email, 'from=2026-10-25&to=2026-10-19')).statusCode).toBe(400);
  expect((await report(seed.admin.email, 'from=2025-01-01&to=2026-10-25')).statusCode).toBe(400); // over 366 days
  expect((await report(seed.admin.email, 'from=ontem&to=hoje')).statusCode).toBe(400);
});
