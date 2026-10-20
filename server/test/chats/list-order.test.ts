import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_SORTS, type ChatListItem } from '@talk/shared';
import { chatPins, chatTags, contactTags, tags } from '../../src/db/schema.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, type SeedChatOpts } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let headers: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  await enableSeeAll(ctx, s.admin);
  ({ headers } = await loginAs(app, s.admin.email));
});
afterEach(async () => {
  await app.close();
});

const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 12, min));
const chat = async (o: Partial<SeedChatOpts> = {}) =>
  (await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ...o })).chatId;

async function list(query: string) {
  const res = await app.inject({ method: 'GET', url: `/api/chats${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: ChatListItem[]; nextCursor: string | null };
}
const ids = (r: { items: ChatListItem[] }) => r.items.map((i) => i.id);

/** Every page of `query`, `limit` chats at a time. */
async function walk(query: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await list(`?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...ids(page));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

describe('GET /api/chats?sort= (spec 2026-10-20 §3)', () => {
  it('orders by last message or by creation date, both ways; the default is the last message, newest first', async () => {
    const a = await chat({ at: t(10), createdAt: t(1) });
    const b = await chat({ at: t(20), createdAt: t(3) });
    const c = await chat({ at: t(5), createdAt: t(2) });

    expect(ids(await list(''))).toEqual([b, a, c]);
    expect(ids(await list('?sort=last_desc'))).toEqual([b, a, c]);
    expect(ids(await list('?sort=last_asc'))).toEqual([c, a, b]);
    expect(ids(await list('?sort=created_desc'))).toEqual([b, c, a]);
    expect(ids(await list('?sort=created_asc'))).toEqual([a, c, b]);
  });

  it('"Esperando há mais tempo": waiting chats first, the longest wait on top, then the rest by last message', async () => {
    const w1 = await chat({ waiting: true, waitingSince: t(8), at: t(30) });
    const w2 = await chat({ waiting: true, waitingSince: t(2), at: t(40) });
    const legacy = await chat({ waiting: true, waitingSince: null, at: t(5) }); // waiting since before migration 0007
    const n1 = await chat({ at: t(50) });
    const n2 = await chat({ at: t(45) });

    expect(ids(await list('?sort=waiting'))).toEqual([w2, legacy, w1, n1, n2]);
    expect(ids(await list('?sort=waiting&tab=waiting'))).toEqual([w2, legacy, w1]);
  });

  it('every order pages through every chat exactly once, across the waiting/rest boundary and on equal keys (Review Focus 1)', async () => {
    const rows = [[t(3), true], [t(3), true], [t(7), true], [t(9), false], [t(9), false]] as const;
    for (const [at, waiting] of rows) await chat({ at, waiting, waitingSince: waiting ? t(1) : null });

    for (const sort of CHAT_SORTS) {
      const whole = ids(await list(`?sort=${sort}`));
      expect(new Set(whole).size, sort).toBe(5);
      expect(await walk(`sort=${sort}`, 2), sort).toEqual(whole);
      expect(await walk(`sort=${sort}`, 1), sort).toEqual(whole);
    }
  });

  it('a cursor of another order, or of the old format, is 400 (Review Focus 2)', async () => {
    await chat({ at: t(1) });
    await chat({ at: t(2) });
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/chats${q}`, headers });
    const first = await list('?limit=1');
    expect(first.nextCursor).not.toBeNull();
    expect((await list(`?limit=1&cursor=${first.nextCursor}`)).items).toHaveLength(1);

    expect((await get(`?sort=created_desc&limit=1&cursor=${first.nextCursor}`)).statusCode).toBe(400);
    const old = Buffer.from(JSON.stringify(['2026-10-20 12:00:00+00', randomUUID()])).toString('base64url');
    expect((await get(`?cursor=${old}`)).statusCode).toBe(400);
    expect((await get('?sort=alfabetica')).statusCode).toBe(400);
  });

  it('pinned chats stay on top in every order', async () => {
    const old = await chat({ at: t(1) });
    await chat({ at: t(2), waiting: true, waitingSince: t(2) });
    await chat({ at: t(3) });
    await ctx.db.insert(chatPins).values({ userId: s.admin.id, chatId: old, createdAt: new Date() });

    for (const sort of CHAT_SORTS) {
      const page = await list(`?sort=${sort}`);
      expect(ids(page)[0], sort).toBe(old);
      expect(page.items[0]!.pinned, sort).toBe(true);
      expect(page.items).toHaveLength(3);
    }
  });

  it('filters by conversation tag, apart from the contact tag (spec §5)', async () => {
    const tagged = await chat({ at: t(1) });
    const { chatId: other, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(2) });
    const [prazo] = await ctx.db.insert(tags).values({ name: 'Prazo', color: '#ef4444' }).returning({ id: tags.id });
    await ctx.db.insert(chatTags).values({ chatId: tagged, tagId: prazo!.id });
    await ctx.db.insert(contactTags).values({ contactId, tagId: prazo!.id });

    expect(ids(await list(`?chatTagId=${prazo!.id}`))).toEqual([tagged]);
    expect(ids(await list(`?tagId=${prazo!.id}`))).toEqual([other]);
    expect(ids(await list(`?tagId=${prazo!.id}&chatTagId=${prazo!.id}`))).toEqual([]);
  });
});
