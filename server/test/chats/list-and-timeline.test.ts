import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatListItem, TimelineItem } from '@talk/shared';
import { chatPins, contactTags, tags } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, seedEvent, seedMessage } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});
afterEach(async () => {
  await app.close();
});

const t = (min: number) => new Date(Date.UTC(2026, 9, 14, 12, min));

async function list(headers: Record<string, string>, query = '') {
  const res = await app.inject({ method: 'GET', url: `/api/chats${query}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as { items: ChatListItem[]; nextCursor: string | null };
}
const ids = (r: { items: ChatListItem[] }) => r.items.map((i) => i.id);

describe('GET /api/chats', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(res.statusCode).toBe(401);
  });

  it('tabs: inbox = all open, waiting = open and waiting, closed = closed', async () => {
    const a = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, waiting: true });
    const b = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, waiting: false });
    const c = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    const { headers } = await loginAs(app, s.admin.email);

    expect(ids(await list(headers)).sort()).toEqual([a.chatId, b.chatId].sort());
    expect(ids(await list(headers, '?tab=inbox')).sort()).toEqual([a.chatId, b.chatId].sort());
    expect(ids(await list(headers, '?tab=waiting'))).toEqual([a.chatId]);
    expect(ids(await list(headers, '?tab=closed'))).toEqual([c.chatId]);
  });

  it('filters by sector, owner, unassigned, contact tag, period, name and phone', async () => {
    const c1 = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id,
      name: 'Maria Souza', phone: '5565999990001', at: t(1),
    });
    const c2 = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorB, ownerId: null,
      name: 'João Lima', phone: '5511988887777', at: t(30),
    });
    const tagId = randomUUID();
    await ctx.db.insert(tags).values({ id: tagId, name: 'VIP', emoji: null, color: '#e11d48', position: 0 });
    await ctx.db.insert(contactTags).values({ contactId: c1.contactId, tagId });
    const { headers } = await loginAs(app, s.admin.email);
    const iso = (d: Date) => encodeURIComponent(d.toISOString());

    expect(ids(await list(headers, `?sectorId=${s.sectorA}`))).toEqual([c1.chatId]);
    expect(ids(await list(headers, '?ownerId=none'))).toEqual([c2.chatId]);
    expect(ids(await list(headers, `?ownerId=${s.agentA.id}`))).toEqual([c1.chatId]);
    const byTag = await list(headers, `?tagId=${tagId}`);
    expect(ids(byTag)).toEqual([c1.chatId]);
    expect(byTag.items[0].tagIds).toEqual([tagId]);
    expect(ids(await list(headers, `?from=${iso(t(10))}`))).toEqual([c2.chatId]);
    expect(ids(await list(headers, `?to=${iso(t(10))}`))).toEqual([c1.chatId]);
    expect(ids(await list(headers, '?q=maria'))).toEqual([c1.chatId]);
    // 12-digit WhatsApp form (no 9) must find the canonical 13-digit phone
    expect(ids(await list(headers, '?q=556599990001'))).toEqual([c1.chatId]);
    expect(ids(await list(headers, '?q=8888'))).toEqual([c2.chatId]);
    expect((await list(headers, '?q=maria')).items[0].contact).toEqual({
      id: c1.contactId, name: 'Maria Souza', phone: '5565999990001',
    });
  });

  it('pinned chats come first, only for the user who pinned them', async () => {
    const old = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(1) });
    const mid = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(2) });
    const neu = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(3) });
    await ctx.db.insert(chatPins).values({ userId: s.agentA.id, chatId: old.chatId, createdAt: new Date() });

    const agent = await loginAs(app, s.agentA.email);
    const mine = await list(agent.headers);
    expect(ids(mine)).toEqual([old.chatId, neu.chatId, mid.chatId]);
    expect(mine.items.map((i) => i.pinned)).toEqual([true, false, false]);

    const admin = await loginAs(app, s.admin.email);
    const theirs = await list(admin.headers);
    expect(ids(theirs)).toEqual([neu.chatId, mid.chatId, old.chatId]);
    expect(theirs.items.every((i) => !i.pinned)).toBe(true);
  });

  it('cursor pagination walks every chat once, newest first', async () => {
    const created: string[] = [];
    for (let i = 1; i <= 5; i++) {
      created.push((await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(i) })).chatId);
    }
    const { headers } = await loginAs(app, s.admin.email);

    const p1 = await list(headers, '?limit=2');
    expect(ids(p1)).toEqual([created[4], created[3]]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await list(headers, `?limit=2&cursor=${p1.nextCursor}`);
    expect(ids(p2)).toEqual([created[2], created[1]]);
    const p3 = await list(headers, `?limit=2&cursor=${p2.nextCursor}`);
    expect(ids(p3)).toEqual([created[0]]);
    expect(p3.nextCursor).toBeNull();

    expect((await app.inject({ method: 'GET', url: '/api/chats?cursor=xyz', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/chats?limit=101', headers })).statusCode).toBe(400);
  });
});

describe('visibility (Review Focus 4, REST)', () => {
  it('an agent of sector A never sees a sector B or private chat via list, detail, timeline, media or actions', async () => {
    const own = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, name: 'Cliente A' });
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    const priv = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id, private: true });
    const mediaId = await seedMessage(ctx, other.chatId, s.channelId, t(1), {
      kind: 'image', mediaPath: '2026/10/x.png', mediaMime: 'image/png', mediaSize: 10, mediaName: 'x.png',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    expect(ids(await list(headers))).toEqual([own.chatId]);
    const detail = await app.inject({ method: 'GET', url: `/api/chats/${own.chatId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().contact.name).toBe('Cliente A');

    for (const url of [
      `/api/chats/${other.chatId}`,
      `/api/chats/${other.chatId}/timeline`,
      `/api/media/${mediaId}`,
      `/api/chats/${priv.chatId}`,
      `/api/chats/${priv.chatId}/timeline`,
    ]) {
      expect((await app.inject({ method: 'GET', url, headers })).statusCode, url).toBe(404);
    }

    const admin = await loginAs(app, s.admin.email);
    expect(ids(await list(admin.headers)).sort()).toEqual([own.chatId, other.chatId, priv.chatId].sort());
  });
});

describe('GET /api/chats/:id/timeline', () => {
  it('merges messages and events by time and pages backwards with before=<oldest id>', async () => {
    const chat = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const e1 = await seedEvent(ctx, chat.chatId, 'created', t(0));
    const m1 = await seedMessage(ctx, chat.chatId, s.channelId, t(1));
    const e2 = await seedEvent(ctx, chat.chatId, 'assigned', t(2));
    const m2 = await seedMessage(ctx, chat.chatId, s.channelId, t(3));
    const { headers } = await loginAs(app, s.agentA.email);
    const get = async (q: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/chats/${chat.chatId}/timeline${q}`, headers });
      expect(res.statusCode).toBe(200);
      return res.json() as TimelineItem[];
    };

    const all = await get('');
    expect(all.map((i) => i.id)).toEqual([e1, m1, e2, m2]);
    expect(all.map((i) => i.type)).toEqual(['event', 'message', 'event', 'message']);
    const firstEvent = all[0];
    expect(firstEvent.type === 'event' && firstEvent.kind).toBe('created');

    expect((await get('?limit=2')).map((i) => i.id)).toEqual([e2, m2]);
    expect((await get(`?limit=2&before=${e2}`)).map((i) => i.id)).toEqual([e1, m1]);
    expect(await get(`?before=${e1}`)).toEqual([]);

    const bad = await app.inject({ method: 'GET', url: `/api/chats/${chat.chatId}/timeline?before=${randomUUID()}`, headers });
    expect(bad.statusCode).toBe(400);
  });
});
