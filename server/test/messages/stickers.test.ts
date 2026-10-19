import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import {
  PHONE, minutesAgo, multipart, seedFile, seedMsg, seedWaitingRun, setupActions, type ActionsWorld,
} from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 fake-sticker');
const recent = (headers = w.headers) => w.app.inject({ method: 'GET', url: '/api/stickers/recent', headers });
const sendJson = (payload: object) => w.app.inject({ method: 'POST', url: `/api/chats/${w.chatId}/messages`, headers: w.headers, payload });
const stickersSent = () => w.ctx.wa.sent.filter((s) => s.method === 'sendSticker');

/** An inbound sticker with a saved file; `sha256` null = a row from before this delivery. */
const sticker = (sha256: string | null, minutes: number, extra: Partial<typeof messages.$inferInsert> = {}) =>
  seedMsg(w, {
    direction: 'in', authorId: null, kind: 'sticker', body: null, mediaMime: 'image/webp',
    mediaPath: `2026/10/${sha256 ?? 'old'}-${minutes}.webp`, mediaSha256: sha256, sentAt: minutesAgo(minutes), ...extra,
  });

describe('GET /api/stickers/recent', () => {
  it('lists the newest stickers of visible chats with a file, one per content, skipping deleted ones', async () => {
    const newest = await sticker('aaa', 1);
    await sticker('aaa', 2); // same file content, older
    const other = await sticker('bbb', 3);
    await sticker('ccc', 4, { deletedAt: new Date(), deletedSource: 'contact' });
    await seedMsg(w, { direction: 'in', authorId: null, kind: 'sticker', body: null, mediaPath: null, sentAt: minutesAgo(5) });
    const legacy = await sticker(null, 6); // no hash: deduped by file path only
    const hidden = await seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5565911112222' });
    await sticker('ddd', 0, { chatId: hidden.chatId });

    const res = await recent();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([newest, other, legacy].map((id) => ({ messageId: id, url: `/api/media/${id}` })));
  });

  it('stops at 40', async () => {
    for (let i = 0; i < 45; i += 1) await sticker(`hash-${i}`, i + 1);
    const list = (await recent()).json() as Array<{ messageId: string }>;
    expect(list).toHaveLength(40);
  });
});

describe('sending stickers', () => {
  it('sends a recent sticker by id, reusing its stored file', async () => {
    const path = await seedFile(w, '2026/10/fig.webp', WEBP);
    const src = await sticker('h1', 3, { mediaPath: path });

    const res = await sendJson({ stickerFromMessageId: src });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ direction: 'out', kind: 'sticker', body: null, authorId: w.s.agentA.id, status: 'sent' });
    const [row] = await w.ctx.db.select().from(messages).where(eq(messages.id, res.json().id));
    expect(row).toMatchObject({ mediaPath: path, mediaMime: 'image/webp', mediaSha256: 'h1', forwardedFromId: null });
    expect(stickersSent()).toMatchObject([{ phone: PHONE, payload: { base64: WEBP.toString('base64') } }]);
  });

  it('sends an uploaded PNG as a sticker; refuses big or non-image files', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\nfake');
    const body = multipart({ asSticker: 'true', signature: 'true', text: 'ignorado' }, { name: 'fig.png', mime: 'image/png', data: png });
    const res = await w.app.inject({
      method: 'POST', url: `/api/chats/${w.chatId}/messages`, headers: { ...w.headers, 'content-type': body.contentType }, payload: body.payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'sticker', body: null });
    expect(stickersSent()).toMatchObject([{ payload: { base64: png.toString('base64') } }]);
    expect(w.ctx.wa.sent.filter((s) => s.method === 'sendMedia')).toEqual([]);

    for (const file of [
      { name: 'grande.png', mime: 'image/png', data: Buffer.alloc(1024 * 1024 + 1) },
      { name: 'anim.gif', mime: 'image/gif', data: Buffer.from('GIF89a') },
    ]) {
      const bad = multipart({ asSticker: 'true' }, file);
      const refused = await w.app.inject({
        method: 'POST', url: `/api/chats/${w.chatId}/messages`, headers: { ...w.headers, 'content-type': bad.contentType }, payload: bad.payload,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: 'Envie uma imagem PNG, JPEG ou WebP de até 1 MB' });
    }
  });

  it('refuses a sticker from a chat the user cannot see (Review Focus 5) and a message that is not a sticker', async () => {
    const hidden = await seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5565911112222' });
    const hiddenSticker = await sticker('h2', 1, { chatId: hidden.chatId });
    expect((await sendJson({ stickerFromMessageId: hiddenSticker })).statusCode).toBe(404);
    const text = await seedMsg(w);
    expect((await sendJson({ stickerFromMessageId: text })).json()).toEqual({ error: 'Figurinha não encontrada' });
    expect(stickersSent()).toEqual([]);
  });

  it('refuses a deleted sticker (409) and a sticker whose file was never downloaded (400)', async () => {
    const gone = await sticker('h5', 1, { deletedAt: new Date(), deletedSource: 'contact' });
    expect(await sendJson({ stickerFromMessageId: gone })).toMatchObject({ statusCode: 409 });
    const noFile = await sticker('h6', 1, { mediaPath: null });
    const res = await sendJson({ stickerFromMessageId: noFile });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Esta mídia não está disponível para encaminhar' });
    expect(stickersSent()).toEqual([]);
  });

  it('asks BOT_RUNNING like any agent send', async () => {
    const path = await seedFile(w, '2026/10/fig2.webp', WEBP);
    const src = await sticker('h3', 1, { mediaPath: path });
    await seedWaitingRun(w);
    const asked = await sendJson({ stickerFromMessageId: src });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().code).toBe('BOT_RUNNING');
    expect((await sendJson({ stickerFromMessageId: src, botAction: 'keep' })).statusCode).toBe(200);
  });

  it('resends a failed sticker through sendSticker', async () => {
    const path = await seedFile(w, '2026/10/fig3.webp', WEBP);
    const src = await sticker('h4', 1, { mediaPath: path });
    w.ctx.wa.failNext();
    const failed = await sendJson({ stickerFromMessageId: src });
    expect(failed.json().status).toBe('failed');
    const resent = await w.app.inject({ method: 'POST', url: `/api/messages/${failed.json().id}/resend`, headers: w.headers });
    expect(resent.json()).toMatchObject({ kind: 'sticker', status: 'sent' });
    expect(stickersSent()).toHaveLength(1);
  });
});
