import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { channels } from '../../src/db/schema.js';
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
      phone: null,
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
    expect(body).toEqual({ id: expect.any(String), name: 'Escritório', status: 'disconnected', phone: null });
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
