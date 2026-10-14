import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { messages } from '../../src/db/schema.js';
import { makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

const upsert = {
  event: 'messages.upsert',
  instance: 'talk-test',
  data: {
    key: { remoteJid: '556599999999@s.whatsapp.net', fromMe: false, id: 'WH1' },
    pushName: 'Maria Cliente',
    message: { conversation: 'oi, tudo bem?' },
    messageType: 'conversation',
    messageTimestamp: 1792000000,
  },
};

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});

afterEach(async () => {
  await app.close();
});

const stored = () => ctx.db.select().from(messages).where(eq(messages.externalId, 'WH1'));

describe('POST /webhooks/evolution/:secret', () => {
  it('rejects a wrong secret with 401 and stores nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/evolution/segredo-errado', payload: upsert });
    expect(res.statusCode).toBe(401);
    expect(await stored()).toHaveLength(0);
  });

  it('stores an incoming message', async () => {
    const res = await app.inject({ method: 'POST', url: `/webhooks/evolution/${ctx.config.webhookSecret}`, payload: upsert });
    expect(res.statusCode).toBe(200);
    expect(await stored()).toHaveLength(1);
  });

  it('answers 200 to a payload it does not understand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${ctx.config.webhookSecret}`,
      payload: { event: 'algo.novo', data: { qualquer: 1 } },
    });
    expect(res.statusCode).toBe(200);
  });
});
