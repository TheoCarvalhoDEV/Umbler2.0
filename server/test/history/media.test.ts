import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, messages } from '../../src/db/schema.js';
import { downloadMessageMedia, drainMediaQueue } from '../../src/history/media.js';
import { toMessageDto } from '../../src/messages/dto.js';
import { MEDIA_UNAVAILABLE } from '../../src/messages/ingest.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedMessage } from '../chats/seed.js';
import { insertChat } from '../inbox/fixtures.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const expired400 = () => new GatewayError('Evolution POST /chat/getBase64FromMediaMessage/talk-test failed: 400 {"status":400}', 400);

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let chatId: string;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z
  s = await seedBasics(ctx);
  chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const media = (externalId: string, sentAt: string, extra: Partial<typeof messages.$inferInsert> = {}) =>
  seedMessage(ctx, chatId, s.channelId, new Date(sentAt), { kind: 'image', body: null, externalId, mediaMime: 'image/jpeg', ...extra });
const queued = (externalId: string, sentAt: string) => media(externalId, sentAt, { mediaStatus: 'queued' });
const row = async (id: string) => (await ctx.db.select().from(messages).where(eq(messages.id, id)))[0]!;

describe('downloadMessageMedia', () => {
  it('saves the file Evolution finds by key.id and clears the queue state', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');

    expect(await downloadMessageMedia(ctx, id)).toBe('saved');

    const m = await row(id);
    expect(m).toMatchObject({
      mediaStatus: null, error: null, mediaMime: 'image/png', mediaSize: Buffer.from(PNG, 'base64').length,
      mediaSha256: expect.stringMatching(/^[0-9a-f]{64}$/), // like live media: the recent-stickers list dedupes by it
    });
    expect((await readFile(join(ctx.config.mediaDir, m.mediaPath!))).toString('base64')).toBe(PNG);
    expect(ctx.wa.mediaLookups).toEqual([{ instance: s.instance, externalId: 'img1' }]);
    expect(ctx.hub.events).toContainEqual({ type: 'message.updated', chatId, messageId: id });
  });

  it('a 400 from Evolution marks the media expired for good (§5.5)', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', expired400());

    expect(await downloadMessageMedia(ctx, id)).toBe('expired');

    const m = await row(id);
    expect(m).toMatchObject({ mediaStatus: 'expired', mediaPath: null, error: null });
    expect(await toMessageDto(ctx.db, m)).toMatchObject({ media: null, mediaUnavailable: true, mediaExpired: true });
    expect(await downloadMessageMedia(ctx, id)).toBe('skipped'); // never asked again
    expect(ctx.wa.mediaLookups).toHaveLength(1);
  });

  it('a temporary failure leaves it downloadable and logs only the error name', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', new Error('The operation was aborted due to timeout'));

    expect(await downloadMessageMedia(ctx, id)).toBe('failed');

    const m = await row(id);
    expect(m).toMatchObject({ mediaStatus: null, error: MEDIA_UNAVAILABLE, mediaPath: null });
    expect(await toMessageDto(ctx.db, m)).toMatchObject({ mediaUnavailable: true, mediaExpired: false });
    expect(logged).toHaveBeenCalledWith('history: media download failed', { messageId: id, err: 'Error' });
  });
});

describe('a disconnected channel', () => {
  it('"Baixar" fails without asking Evolution or touching the message', async () => {
    await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, s.channelId));
    const id = await media('aud1', '2026-10-10T12:00:00Z', { error: MEDIA_UNAVAILABLE });

    expect(await downloadMessageMedia(ctx, id)).toBe('failed');

    expect(await row(id)).toMatchObject({ mediaStatus: null, error: MEDIA_UNAVAILABLE, mediaPath: null });
    expect(ctx.wa.mediaLookups).toEqual([]);
  });
});

describe('drainMediaQueue', () => {
  it('stops at the first failed download and leaves the rest queued', async () => {
    const a = await queued('a', '2026-10-12T12:00:00Z');
    const b = await queued('b', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('a', new Error('connect ECONNREFUSED'));

    expect(await drainMediaQueue(ctx)).toBe(1);

    expect(ctx.wa.mediaLookups.map((l) => l.externalId)).toEqual(['a']);
    expect((await row(b)).mediaStatus).toBe('queued');
    expect((await row(a)).error).toBe(MEDIA_UNAVAILABLE);
  });

  it('downloads queued media one at a time, newest first; what aged past 21 days becomes expired unasked', async () => {
    const a = await queued('a', '2026-10-10T12:00:00Z');
    const b = await queued('b', '2026-10-12T12:00:00Z');
    const old = await queued('velha', '2026-09-01T12:00:00Z');

    expect(await drainMediaQueue(ctx)).toBe(2);

    expect(ctx.wa.mediaLookups.map((l) => l.externalId)).toEqual(['b', 'a']);
    expect((await row(a)).mediaPath).not.toBeNull();
    expect((await row(b)).mediaPath).not.toBeNull();
    expect((await row(old)).mediaStatus).toBe('expired');
  });

  it('leaves queued media alone while the channel is disconnected (Review Focus 4)', async () => {
    await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, s.channelId));
    const a = await queued('a', '2026-10-10T12:00:00Z');

    expect(await drainMediaQueue(ctx)).toBe(0);

    expect((await row(a)).mediaStatus).toBe('queued');
    expect(ctx.wa.mediaLookups).toEqual([]);
  });

  it('stops when the signal aborts', async () => {
    await queued('a', '2026-10-10T12:00:00Z');
    const stop = new AbortController();
    stop.abort();
    expect(await drainMediaQueue(ctx, stop.signal)).toBe(0);
  });
});

describe('POST /api/messages/:id/media ("Baixar")', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await makeTestApp(ctx));
  });
  afterEach(async () => {
    await app.close();
  });

  const post = async (email: string, id: string) => {
    const { headers } = await loginAs(app, email);
    return app.inject({ method: 'POST', url: `/api/messages/${id}/media`, headers });
  };

  it('downloads a file that failed before and returns the message with it', async () => {
    const id = await media('aud1', '2026-10-10T12:00:00Z', { kind: 'audio', error: MEDIA_UNAVAILABLE });
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, media: { url: `/api/media/${id}` }, mediaUnavailable: false, mediaExpired: false, error: null });
  });

  it('is 404 for a chat the user cannot see', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    expect((await post(s.agentB.email, id)).statusCode).toBe(404);
    expect(ctx.wa.mediaLookups).toEqual([]);
  });

  it('answers an expired file as expired without asking WhatsApp again', async () => {
    const id = await media('img1', '2026-08-01T12:00:00Z', { mediaStatus: 'expired' });
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mediaExpired: true });
    expect(ctx.wa.mediaLookups).toEqual([]);
  });

  it('a 400 from WhatsApp turns the message expired', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', expired400());
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mediaExpired: true, media: null });
  });

  it('a temporary failure is 502 and the message stays downloadable', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', new Error('ECONNRESET'));
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Não foi possível baixar o arquivo. Tente de novo.');
    expect((await row(id)).mediaStatus).toBeNull();
  });

  it('a text message has nothing to download', async () => {
    const id = await seedMessage(ctx, chatId, s.channelId, new Date('2026-10-10T12:00:00Z'), { externalId: 't1' });
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Esta mensagem não tem arquivo.');
  });
});
