import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { channels, contacts, messages } from '../../src/db/schema.js';
import { makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

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

// Synthetic Evolution v2 messages.upsert (no real data). 12-digit JID: DDD 65 mobile without the 9.
function upsert(externalId: string) {
  return {
    event: 'messages.upsert',
    instance: seed.instance,
    data: {
      key: { remoteJid: '556599990001@s.whatsapp.net', fromMe: false, id: externalId },
      pushName: 'Cliente Webhook',
      message: { conversation: 'Olá, preciso falar com o escritório' },
      messageType: 'conversation',
      messageTimestamp: 1760450000,
      source: 'android',
    },
    date_time: '2026-10-14T12:00:00.000Z',
    sender: '556500000000@s.whatsapp.net',
    server_url: 'http://evolution:8080',
  };
}

const post = (secret: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/webhooks/evolution/${secret}`, payload: payload as object });

describe('POST /webhooks/evolution/:secret', () => {
  it('rejects a wrong secret with 401 and stores nothing', async () => {
    const res = await post('segredo-errado', upsert('3EB0WEBHOOK00001'));
    expect(res.statusCode).toBe(401);
    expect(await ctx.db.select().from(messages).where(eq(messages.externalId, '3EB0WEBHOOK00001'))).toHaveLength(0);
  });

  it('stores an incoming message end-to-end, once, even when delivered twice', async () => {
    const first = await post(ctx.config.webhookSecret, upsert('3EB0WEBHOOK00002'));
    const second = await post(ctx.config.webhookSecret, upsert('3EB0WEBHOOK00002'));

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const rows = await ctx.db.select().from(messages).where(eq(messages.externalId, '3EB0WEBHOOK00002'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('in');
    expect(rows[0]!.body).toBe('Olá, preciso falar com o escritório');
    expect(await ctx.db.select().from(contacts).where(eq(contacts.phone, '5565999990001'))).toHaveLength(1);
  });

  it('applies connection.update to the channel status through the shared setChannelStatus', async () => {
    await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, seed.channelId));

    const res = await post(ctx.config.webhookSecret, {
      event: 'connection.update',
      instance: seed.instance,
      data: { instance: seed.instance, state: 'open', statusReason: 200, wuid: '5565988887777@s.whatsapp.net' },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId));
    expect(row!.status).toBe('connected');
    expect(row!.phone).toBe('5565988887777'); // wuid → channels.phone (spec §3.1)
    expect(ctx.hub.events).toContainEqual(expect.objectContaining({ channelId: seed.channelId }));
  });

  it('answers 200 to an unknown payload', async () => {
    expect((await post(ctx.config.webhookSecret, { event: 'algo.novo', foo: 1 })).statusCode).toBe(200);
    expect((await post(ctx.config.webhookSecret, [1, 2, 3])).statusCode).toBe(200);
  });

  it('answers 500 when the database fails, so Evolution retries', async () => {
    // handleInbound stores messages inside ctx.db.transaction (Task 9)
    vi.spyOn(ctx.db, 'transaction').mockRejectedValue(Object.assign(new Error('banco fora do ar'), { code: '57P01' }));

    const res = await post(ctx.config.webhookSecret, upsert('3EB0WEBHOOK00003'));

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Ocorreu um erro' });
  });
});
