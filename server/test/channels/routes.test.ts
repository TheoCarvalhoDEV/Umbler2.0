import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { STARTER_GRAPH, createBot } from '../../src/bots/repo.js';
import { bots, channels, chats, contacts, messages, scheduledMessages } from '../../src/db/schema.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { seedChat, seedMessage } from '../chats/seed.js';
import { handleInbound } from '../../src/messages/ingest.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type Seed = Awaited<ReturnType<typeof seedBasics>>;

let ctx: Ctx;
let seed: Seed;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});

afterEach(async () => {
  await app.close();
});

describe('channel routes', () => {
  it('GET /api/channels lists channels for any logged user', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'GET', url: '/api/channels', headers: agent.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual({
      id: seed.channelId,
      name: expect.any(String),
      status: expect.stringMatching(/^(disconnected|connecting|connected)$/),
      phone: null, historyPeriod: '3m', disconnectedAt: null, historyImport: null,
    });
  });

  it('GET /api/channels without session is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/channels is admin only', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'POST', url: '/api/channels', headers: agent.headers, payload: { name: 'Outro' } });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/channels creates the channel and the Evolution instance', async () => {
    const spy = vi.spyOn(ctx.wa, 'createInstance').mockResolvedValue(undefined);
    const admin = await loginAs(app, seed.admin.email);

    const res = await app.inject({ method: 'POST', url: '/api/channels', headers: admin.headers, payload: { name: '  Escritório  ' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ id: expect.any(String), name: 'Escritório', status: 'disconnected', phone: null, historyPeriod: '3m', disconnectedAt: null, historyImport: null });
    expect(spy).toHaveBeenCalledWith(`talk-${body.id.slice(0, 8)}`, expect.stringContaining('/webhooks/evolution/'));
  });

  it('POST /api/channels rejects an empty name with 400', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'POST', url: '/api/channels', headers: admin.headers, payload: { name: '   ' } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/channels/:id/connect returns the QR for admins', async () => {
    vi.spyOn(ctx.wa, 'connect').mockResolvedValue({ qrBase64: 'data:image/png;base64,QRTESTE' });
    const admin = await loginAs(app, seed.admin.email);

    const res = await app.inject({ method: 'POST', url: `/api/channels/${seed.channelId}/connect`, headers: admin.headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ qrBase64: 'data:image/png;base64,QRTESTE' });
  });

  it('POST /api/channels/:id/connect with an unknown id is 404', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'POST', url: `/api/channels/${crypto.randomUUID()}/connect`, headers: admin.headers });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/channels/:id/qr returns the latest qrcode.updated image for admins (§5.6)', async () => {
    await ctx.db.update(channels).set({ status: 'connecting' }).where(eq(channels.id, seed.channelId));
    await handleInbound(ctx, [{ type: 'qrcode', instance: seed.instance, qrBase64: 'data:image/png;base64,QRNOVO' }]);
    const admin = await loginAs(app, seed.admin.email);

    const res = await app.inject({ method: 'GET', url: `/api/channels/${seed.channelId}/qr`, headers: admin.headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ qrBase64: 'data:image/png;base64,QRNOVO' });
  });

  it('GET /api/channels/:id/qr is admin only', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'GET', url: `/api/channels/${seed.channelId}/qr`, headers: agent.headers });
    expect(res.statusCode).toBe(403);
  });
});

describe('history routes (§5.1)', () => {
  const importUrl = () => `/api/channels/${seed.channelId}/history-import`;
  const channelRow = async () => (await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId)))[0]!;

  it('POST /api/channels/:id/history-import is admin only', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'POST', url: importUrl(), headers: agent.headers, payload: { period: '3m' } });
    expect(res.statusCode).toBe(403);
  });

  it('starts an import with the period, keeps the period on the channel and answers the channel', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: '12m' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: seed.channelId, historyPeriod: '12m', historyImport: { period: '12m', state: 'running', messagesImported: 0 },
    });
    expect((await channelRow()).historyPeriod).toBe('12m');
  });

  it('a second request while one runs is 409 "Já existe uma importação em andamento" and keeps the period', async () => {
    const admin = await loginAs(app, seed.admin.email);
    await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: '3m' } });
    const res = await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: 'all' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Já existe uma importação em andamento');
    expect((await channelRow()).historyPeriod).toBe('3m');
  });

  it('rejects an unknown period (400) and an unknown channel (404)', async () => {
    const admin = await loginAs(app, seed.admin.email);
    expect((await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: '6m' } })).statusCode).toBe(400);
    const res = await app.inject({
      method: 'POST', url: `/api/channels/${crypto.randomUUID()}/history-import`, headers: admin.headers, payload: { period: '3m' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('connect keeps the chosen period on the channel before asking Evolution for the QR', async () => {
    const connect = vi.spyOn(ctx.wa, 'connect');
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({
      method: 'POST', url: `/api/channels/${seed.channelId}/connect`, headers: admin.headers, payload: { historyPeriod: 'all' },
    });
    expect(res.statusCode).toBe(200);
    expect(connect).toHaveBeenCalledWith(seed.instance);
    expect((await channelRow()).historyPeriod).toBe('all');
  });

  it('connect without a body keeps working, and a bad period is 400', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const url = `/api/channels/${seed.channelId}/connect`;
    expect((await app.inject({ method: 'POST', url, headers: admin.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: admin.headers, payload: { historyPeriod: 'x' } })).statusCode).toBe(400);
  });
});

describe('DELETE /api/channels/:id', () => {
  const url = (id = seed.channelId) => `/api/channels/${id}`;
  const channelIds = async () => (await ctx.db.select({ id: channels.id }).from(channels)).map((c) => c.id);

  /** A chat on the seed channel with its own file and a file it shares with a chat on another channel; a bot starting on both. */
  async function seedChannelData() {
    const [other] = await ctx.db
      .insert(channels)
      .values({ name: 'Outro', evolutionInstance: 'talk-outro', status: 'connected' })
      .returning({ id: channels.id });
    const at = new Date('2026-10-10T12:00:00Z');
    await mkdir(join(ctx.config.mediaDir, '2026/10'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, '2026/10/foto.jpg'), 'x');
    await writeFile(join(ctx.config.mediaDir, '2026/10/compartilhada.jpg'), 'x');
    const mine = await seedChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, phone: '5565999990001' });
    await seedMessage(ctx, mine.chatId, seed.channelId, at, { kind: 'image', mediaPath: '2026/10/foto.jpg', externalId: 'C1' });
    await seedMessage(ctx, mine.chatId, seed.channelId, at, { kind: 'image', mediaPath: '2026/10/compartilhada.jpg', externalId: 'C2' });
    // a scheduled message's file (any state) goes with its chat
    await writeFile(join(ctx.config.mediaDir, '2026/10/agendado.pdf'), 'x');
    await ctx.db.insert(scheduledMessages).values({
      chatId: mine.chatId, authorId: seed.agentA.id, body: 'Lembrete', signature: false, sendAt: at, mediaPath: '2026/10/agendado.pdf',
    });
    const kept = await seedChat(ctx, { channelId: other!.id, sectorId: seed.sectorA, contactId: mine.contactId });
    await seedMessage(ctx, kept.chatId, other!.id, at, { kind: 'image', mediaPath: '2026/10/compartilhada.jpg', externalId: 'C3' });
    const bot = await createBot(ctx.db, {
      name: 'Recepção', graph: STARTER_GRAPH(), valid: true, publish: false, createdBy: null, startChannelIds: [seed.channelId, other!.id],
    });
    return { otherId: other!.id, mine, kept, botId: bot.id };
  }

  it('is admin only, and 404 for an unknown channel', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    expect((await app.inject({ method: 'DELETE', url: url(), headers: agent.headers })).statusCode).toBe(403);
    expect(await channelIds()).toContain(seed.channelId);

    const admin = await loginAs(app, seed.admin.email);
    expect((await app.inject({ method: 'DELETE', url: url(crypto.randomUUID()), headers: admin.headers })).statusCode).toBe(404);
  });

  it('logs WhatsApp out and deletes the channel with its chats, messages and own files; contacts, other channels and shared files stay', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { otherId, mine, kept, botId } = await seedChannelData();
    const admin = await loginAs(app, seed.admin.email);

    const res = await app.inject({ method: 'DELETE', url: url(), headers: admin.headers });

    expect(res.statusCode).toBe(204);
    expect(ctx.wa.sent).toContainEqual({ method: 'deleteInstance', instance: seed.instance, payload: null });
    expect(await channelIds()).toEqual([otherId]);
    expect(await ctx.db.select().from(chats).where(eq(chats.channelId, seed.channelId))).toEqual([]);
    expect(await ctx.db.select().from(messages).where(eq(messages.chatId, mine.chatId))).toEqual([]);
    expect(await ctx.db.select().from(chats).where(eq(chats.id, kept.chatId))).toHaveLength(1);
    expect(await ctx.db.select().from(contacts).where(eq(contacts.id, mine.contactId))).toHaveLength(1);
    expect(existsSync(join(ctx.config.mediaDir, '2026/10/foto.jpg'))).toBe(false);
    expect(existsSync(join(ctx.config.mediaDir, '2026/10/agendado.pdf'))).toBe(false);
    expect(existsSync(join(ctx.config.mediaDir, '2026/10/compartilhada.jpg'))).toBe(true); // the other channel still uses it
    const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    expect(bot!.startChannelIds).toEqual([otherId]);
    expect(ctx.hub.events).toContainEqual({ type: 'chat.removed', chatId: mine.chatId });
    expect(ctx.hub.events).toContainEqual({ type: 'channel.removed', channelId: seed.channelId });
    expect(console.info).toHaveBeenCalledWith('channel deleted', { channelId: seed.channelId, userId: seed.admin.id, chats: 1 });
  });

  it('keeps everything when Evolution fails (502); an instance already gone (404) does not block', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { mine } = await seedChannelData();
    const remove = vi.spyOn(ctx.wa, 'deleteInstance');
    const admin = await loginAs(app, seed.admin.email);

    remove.mockRejectedValueOnce(new GatewayError('Evolution DELETE failed: 500', 500));
    const failed = await app.inject({ method: 'DELETE', url: url(), headers: admin.headers });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('Não foi possível desconectar o WhatsApp deste canal. Tente de novo.');
    expect(await channelIds()).toContain(seed.channelId);
    expect(await ctx.db.select().from(chats).where(eq(chats.id, mine.chatId))).toHaveLength(1);

    remove.mockRejectedValueOnce(new GatewayError('Evolution DELETE failed: 404', 404));
    expect((await app.inject({ method: 'DELETE', url: url(), headers: admin.headers })).statusCode).toBe(204);
    expect(await channelIds()).not.toContain(seed.channelId);
  });
});
