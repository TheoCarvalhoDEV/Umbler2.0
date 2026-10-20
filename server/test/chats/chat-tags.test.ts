import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDetail } from '@talk/shared';
import { contactTags, tags } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, type SeedChatOpts } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let headers: Record<string, string>;
let prazo: string; // catalog position 1
let audiencia: string; // catalog position 0

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ({ headers } = await loginAs(app, s.agentA.email));
  const rows = await ctx.db
    .insert(tags)
    .values([{ name: 'Prazo', color: '#ef4444', position: 1 }, { name: 'Audiência', color: '#2563eb', position: 0 }])
    .returning({ id: tags.id });
  [prazo, audiencia] = rows.map((r) => r.id) as [string, string];
});
afterEach(async () => {
  await app.close();
});

/** agentA's chat in sector A. */
const mine = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, ...o });
const put = (chatId: string, tagIds: string[], h: Record<string, string> = headers) =>
  app.inject({ method: 'PUT', url: `/api/chats/${chatId}/tags`, headers: h, payload: { tagIds } });
const detail = async (chatId: string) =>
  (await app.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers })).json() as ChatDetail;

describe('PUT /api/chats/:id/tags (spec 2026-10-20 §5)', () => {
  it('replaces the conversation tags, apart from the contact tags, and answers the ChatDetail', async () => {
    const { chatId, contactId } = await mine();
    await ctx.db.insert(contactTags).values({ contactId, tagId: prazo });

    const res = await put(chatId, [prazo, prazo]);

    expect(res.statusCode).toBe(200);
    expect(res.json() as ChatDetail).toMatchObject({ id: chatId, chatTagIds: [prazo], tagIds: [prazo] });
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    expect(((await put(chatId, [])).json() as ChatDetail).chatTagIds).toEqual([]);
    expect((await detail(chatId)).tagIds).toEqual([prazo]); // the contact's tag never moved
    expect(ctx.wa.sent).toEqual([]);
  });

  it('lists them in catalog order, on a closed chat too, and they survive reopening', async () => {
    const { chatId } = await mine({ state: 'closed' });
    expect(((await put(chatId, [prazo, audiencia])).json() as ChatDetail).chatTagIds).toEqual([audiencia, prazo]);

    const reopened = await app.inject({ method: 'POST', url: `/api/chats/${chatId}/reopen`, headers });

    expect(reopened.statusCode).toBe(200);
    expect(reopened.json() as ChatDetail).toMatchObject({ state: 'open', chatTagIds: [audiencia, prazo] });
  });

  it('400 for an unknown tag or more than 50, 404 for a chat the user cannot see, 403 without Origin', async () => {
    const { chatId } = await mine();
    await put(chatId, [prazo]);

    expect((await put(chatId, [audiencia, randomUUID()])).statusCode).toBe(400);
    expect((await put(chatId, Array.from({ length: 51 }, () => randomUUID()))).statusCode).toBe(400);
    expect((await detail(chatId)).chatTagIds).toEqual([prazo]); // the refused requests changed nothing
    const hidden = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    expect((await put(hidden.chatId, [prazo])).statusCode).toBe(404);
    expect((await put(chatId, [audiencia], { cookie: headers.cookie! })).statusCode).toBe(403);
  });

  it('a tag deleted from the catalog leaves every conversation (Review Focus 6)', async () => {
    const { chatId } = await mine();
    await put(chatId, [prazo, audiencia]);
    const admin = await loginAs(app, s.admin.email);

    expect((await app.inject({ method: 'DELETE', url: `/api/tags/${audiencia}`, headers: admin.headers })).statusCode).toBe(204);

    expect((await detail(chatId)).chatTagIds).toEqual([prazo]);
  });
});
