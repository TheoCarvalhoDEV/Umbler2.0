import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { contacts, messages } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { saveMedia } from '../../src/messages/media.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const ctx = await makeTestCtx();
  ctx.config.mediaDir = await mkdtemp(join(tmpdir(), 'talk-media-'));
  const seed = await seedBasics(ctx);
  const built = await makeTestApp(ctx);
  app = built.app;

  const contactId = randomUUID();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria', phone: '5565999990001' });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId,
    channelId: seed.channelId,
    init: { sectorId: seed.sectorA, ownerId: null, waiting: true, triagePending: false, createdBy: null },
  });

  const html = '<html><script>alert(document.cookie)</script></html>';
  const saved = await saveMedia(ctx.config.mediaDir, Buffer.from(html), 'text/html', 'x.html');
  const mediaId = randomUUID();
  await ctx.db.insert(messages).values({
    id: mediaId, chatId: chat.id, channelId: seed.channelId, direction: 'in', kind: 'document', body: null,
    mediaPath: saved.path, mediaMime: 'text/html', mediaSize: saved.size, mediaName: 'x.html',
    externalId: 'EXT-HTML', status: 'sent', sentAt: new Date(),
  });
  const textId = randomUUID();
  await ctx.db.insert(messages).values({
    id: textId, chatId: chat.id, channelId: seed.channelId, direction: 'in', kind: 'text', body: 'oi',
    externalId: 'EXT-TXT', status: 'sent', sentAt: new Date(),
  });
  return { ctx, seed, app: built.app, html, mediaId, textId, savedPath: saved.path };
}

describe('GET /api/media/:messageId', () => {
  it('serves a visible file as a sandboxed attachment (Review Focus 5)', async () => {
    const { seed, app, html, mediaId } = await setup();
    const a = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(html);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="x\.html"/);
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    // admin: held by the sector barrier until "ver todos" is on
    const admin = await loginAs(app, seed.admin.email);
    const get = () => app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: admin.headers });
    expect((await get()).statusCode).toBe(404);
    await app.inject({ method: 'PUT', url: '/api/auth/me/view', headers: admin.headers, payload: { seeAllSectors: true } });
    expect((await get()).statusCode).toBe(200);
  });

  it('is 404 for an agent of another sector (Review Focus 4)', async () => {
    const { seed, app, mediaId } = await setup();
    const b = await loginAs(app, seed.agentB.email);
    const res = await app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: b.headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Não encontrado' });
  });

  it('is 404 for a message without media, a non-uuid id, an unknown id and a missing file', async () => {
    const { ctx, seed, app, textId, mediaId, savedPath } = await setup();
    const a = await loginAs(app, seed.agentA.email);
    for (const id of [textId, 'nao-e-uuid', randomUUID()]) {
      expect((await app.inject({ method: 'GET', url: `/api/media/${id}`, headers: a.headers })).statusCode).toBe(404);
    }
    await rm(join(ctx.config.mediaDir, savedPath));
    expect((await app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: a.headers })).statusCode).toBe(404);
  });

  it('is 401 without a session', async () => {
    const { app, mediaId } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/media/${mediaId}` });
    expect(res.statusCode).toBe(401);
  });
});
