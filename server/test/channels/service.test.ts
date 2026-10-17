import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels } from '../../src/db/schema.js';
import {
  connectChannel,
  createChannel,
  getChannelByInstance,
  getChannelQr,
  getChannelQrById,
  setChannelQr,
  setChannelStatus,
  syncChannelStatuses,
  syncWebhooks,
} from '../../src/channels/service.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type Seed = Awaited<ReturnType<typeof seedBasics>>;

let ctx: Ctx;
let seed: Seed;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, seed.channelId));
});

async function statusOf(id: string) {
  const [row] = await ctx.db.select().from(channels).where(eq(channels.id, id));
  return row!.status;
}

const channelEvents = (id: string) => ctx.hub.events.filter((e) => e.channelId === id).length;

describe('createChannel', () => {
  it('stores a disconnected channel and creates the Evolution instance pointing at the internal webhook', async () => {
    const spy = vi.spyOn(ctx.wa, 'createInstance').mockResolvedValue(undefined);

    const dto = await createChannel(ctx, 'Escritório');

    expect(dto).toEqual({ id: expect.any(String), name: 'Escritório', status: 'disconnected', phone: null });
    const instance = `talk-${dto.id.slice(0, 8)}`;
    expect(spy).toHaveBeenCalledWith(
      instance,
      `${ctx.config.webhookBaseUrl}/webhooks/evolution/${ctx.config.webhookSecret}`,
    );
    expect((await getChannelByInstance(ctx.db, instance))?.id).toBe(dto.id);
  });

  it('removes the row when Evolution refuses the instance', async () => {
    vi.spyOn(ctx.wa, 'createInstance').mockRejectedValue(new Error('evolution fora do ar'));

    await expect(createChannel(ctx, 'Falhou')).rejects.toThrow('evolution fora do ar');

    const rows = await ctx.db.select().from(channels).where(eq(channels.name, 'Falhou'));
    expect(rows).toHaveLength(0);
  });
});

describe('connectChannel', () => {
  it('returns the QR, marks the channel connecting and publishes channel.status', async () => {
    vi.spyOn(ctx.wa, 'connect').mockResolvedValue({ qrBase64: 'data:image/png;base64,QRTESTE' });

    await expect(connectChannel(ctx, seed.channelId)).resolves.toEqual({ qrBase64: 'data:image/png;base64,QRTESTE' });

    expect(await statusOf(seed.channelId)).toBe('connecting');
    expect(channelEvents(seed.channelId)).toBe(1);
    // stored so GET /api/channels/:id/qr has it before the first qrcode.updated webhook
    expect(getChannelQr(ctx, seed.instance)).toBe('data:image/png;base64,QRTESTE');
  });

  it('without a QR asks Evolution for the real state instead of guessing', async () => {
    vi.spyOn(ctx.wa, 'connect').mockResolvedValue({ qrBase64: null });
    vi.spyOn(ctx.wa, 'connectionState').mockResolvedValue('connected');

    await expect(connectChannel(ctx, seed.channelId)).resolves.toEqual({ qrBase64: null });

    expect(await statusOf(seed.channelId)).toBe('connected');
  });

  it('rejects an unknown channel with 404', async () => {
    await expect(connectChannel(ctx, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe('setChannelStatus / syncChannelStatuses', () => {
  it('sync corrects a stale status and publishes only when it changes', async () => {
    vi.spyOn(ctx.wa, 'connectionState').mockResolvedValue('connected');

    await syncChannelStatuses(ctx);
    expect(await statusOf(seed.channelId)).toBe('connected');
    expect(channelEvents(seed.channelId)).toBe(1);

    await syncChannelStatuses(ctx);
    expect(channelEvents(seed.channelId)).toBe(1);
  });

  it('setChannelStatus ignores an unknown instance', async () => {
    await setChannelStatus(ctx, 'talk-naoexiste', 'connected');
    expect(ctx.hub.events.filter((e) => e.channelId)).toHaveLength(0);
  });

  it('setChannelStatus stores the phone and publishes when only the phone changes', async () => {
    await setChannelStatus(ctx, seed.instance, 'connected', '5565988887777');
    await setChannelStatus(ctx, seed.instance, 'connected', '5565911112222');
    const [row] = await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId));
    expect(row!.phone).toBe('5565911112222');
    expect(channelEvents(seed.channelId)).toBe(2);
  });
});

describe('getChannelQrById', () => {
  it('returns the latest stored QR while not connected, null once connected, 404 for an unknown id', async () => {
    await ctx.db.update(channels).set({ status: 'connecting' }).where(eq(channels.id, seed.channelId));
    setChannelQr(ctx, seed.instance, 'data:image/png;base64,NOVO');
    await expect(getChannelQrById(ctx, seed.channelId)).resolves.toEqual({ qrBase64: 'data:image/png;base64,NOVO' });

    await setChannelStatus(ctx, seed.instance, 'connected');
    await expect(getChannelQrById(ctx, seed.channelId)).resolves.toEqual({ qrBase64: null });

    await expect(getChannelQrById(ctx, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe('syncWebhooks', () => {
  it('pushes the webhook URL to every instance; one failure does not stop the others', async () => {
    await ctx.db.insert(channels).values({ name: 'Outro', evolutionInstance: 'talk-outro', status: 'disconnected' });
    const calls: string[] = [];
    let first = true;
    ctx.wa.setWebhook = async (instance, url) => {
      calls.push(`${instance} ${url}`);
      if (first) {
        first = false;
        throw new Error('evolution down');
      }
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await syncWebhooks(ctx);

    const url = 'http://app:3000/webhooks/evolution/test-webhook-secret-0123456789abcdef';
    expect(calls.sort()).toEqual([`talk-outro ${url}`, `talk-test ${url}`]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('webhook sync failed', { instance: expect.any(String), err: 'Error' });
    logged.mockRestore();
  });
});
