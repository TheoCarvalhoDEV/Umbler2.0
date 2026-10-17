import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, contacts, messages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { seedFile, seedMsg, seedWaitingRun, setupActions, type ActionsWorld } from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const forward = (id: string, payload: object) =>
  w.app.inject({ method: 'POST', url: `/api/messages/${id}/forward`, headers: w.headers, payload });
const sentBy = (method: string) => w.ctx.wa.sent.filter((s) => s.method === method);
const otherOpenChat = () =>
  seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorA, ownerId: w.s.agentA.id, phone: '5565988887777', name: 'Outro' });
const newContact = async () =>
  (await w.ctx.db.insert(contacts).values({ name: 'Novo', phone: '5565977776666' }).returning())[0]!;

describe('POST /api/messages/:id/forward', () => {
  it('forwards a text to another open chat, unsigned and marked as forwarded', async () => {
    const src = await seedMsg(w, { direction: 'in', authorId: null, body: 'Meu CPF é 123' });
    const dest = await otherOpenChat();

    const res = await forward(src, { chatId: dest.chatId });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      chatId: dest.chatId, direction: 'out', kind: 'text', body: 'Meu CPF é 123', forwarded: true, authorId: w.s.agentA.id,
    });
    const [row] = await w.ctx.db.select().from(messages).where(eq(messages.id, res.json().id));
    expect(row!.forwardedFromId).toBe(src);
    expect(sentBy('sendText')).toMatchObject([{ phone: '5565988887777', payload: { text: 'Meu CPF é 123' } }]);
  });

  it('forwards a photo with its caption to a contact without an open chat, opening one', async () => {
    const path = await seedFile(w, '2026/10/foto.jpg', Buffer.from('jpeg-bytes'));
    const src = await seedMsg(w, {
      direction: 'in', authorId: null, kind: 'image', body: 'Comprovante', mediaPath: path, mediaMime: 'image/jpeg', mediaSize: 10,
    });
    const contact = await newContact();

    const res = await forward(src, { contactId: contact.id });

    expect(res.statusCode).toBe(200);
    const [chat] = await w.ctx.db.select().from(chats).where(eq(chats.contactId, contact.id));
    expect(chat).toMatchObject({ state: 'open', ownerId: w.s.agentA.id, channelId: w.s.channelId });
    expect(res.json()).toMatchObject({ chatId: chat!.id, kind: 'image', body: 'Comprovante', forwarded: true });
    expect(sentBy('sendMedia')).toMatchObject([
      {
        phone: '5565977776666',
        payload: { media: { kind: 'image', base64: Buffer.from('jpeg-bytes').toString('base64'), mime: 'image/jpeg', caption: 'Comprovante' } },
      },
    ]);
  });

  it('forwards a sticker as a sticker', async () => {
    const path = await seedFile(w, '2026/10/fig.webp', Buffer.from('RIFFwebp'));
    const src = await seedMsg(w, { direction: 'in', authorId: null, kind: 'sticker', body: null, mediaPath: path, mediaMime: 'image/webp' });
    const dest = await otherOpenChat();
    expect((await forward(src, { chatId: dest.chatId })).json()).toMatchObject({ kind: 'sticker', forwarded: true });
    expect(sentBy('sendSticker')).toHaveLength(1);
  });

  it('refuses media that was never downloaded and opens no chat', async () => {
    const src = await seedMsg(w, { direction: 'in', authorId: null, kind: 'video', body: null, mediaPath: null, error: 'mídia indisponível' });
    const contact = await newContact();

    const res = await forward(src, { contactId: contact.id });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Esta mídia não está disponível para encaminhar' });
    expect(await w.ctx.db.select().from(chats).where(eq(chats.contactId, contact.id))).toEqual([]);
  });

  it('never forwards notes or deleted messages', async () => {
    const dest = await otherOpenChat();
    const note = await seedMsg(w, { kind: 'note', externalId: null });
    const refused = await forward(note, { chatId: dest.chatId });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'Esta mensagem não pode ser encaminhada' });
    const gone = await seedMsg(w, { deletedAt: new Date(), deletedSource: 'contact', direction: 'in', authorId: null });
    expect((await forward(gone, { chatId: dest.chatId })).json()).toEqual({ error: 'Mensagem apagada' });
  });

  it('asks BOT_RUNNING when the destination has a running chatbot', async () => {
    const src = await seedMsg(w);
    const dest = await otherOpenChat();
    await seedWaitingRun(w, dest.chatId, dest.contactId);

    const asked = await forward(src, { chatId: dest.chatId });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().code).toBe('BOT_RUNNING');
    expect((await forward(src, { chatId: dest.chatId, botAction: 'keep' })).statusCode).toBe(200);
  });

  it('needs canSee on both ends (Review Focus 5)', async () => {
    const hidden = await seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5565966665555' });
    const src = await seedMsg(w);
    expect((await forward(src, { chatId: hidden.chatId })).statusCode).toBe(404);
    const hiddenSrc = await seedMsg(w, { chatId: hidden.chatId, direction: 'in', authorId: null });
    const dest = await otherOpenChat();
    expect((await forward(hiddenSrc, { chatId: dest.chatId })).statusCode).toBe(404);
    expect(sentBy('sendText')).toEqual([]);
  });

  it('refuses a closed destination and a message from a closed chat', async () => {
    const closedDest = await seedChat(w.ctx, {
      channelId: w.s.channelId, sectorId: w.s.sectorA, ownerId: w.s.agentA.id, phone: '5565955554444', state: 'closed',
    });
    const src = await seedMsg(w);
    expect((await forward(src, { chatId: closedDest.chatId })).json()).toEqual({ error: 'Conversa finalizada' });

    const dest = await otherOpenChat();
    await w.ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, w.chatId));
    expect((await forward(src, { chatId: dest.chatId })).json()).toEqual({ error: 'Conversa finalizada' });
  });

  it('rejects a body with neither chatId nor contactId', async () => {
    const src = await seedMsg(w);
    expect((await forward(src, {})).statusCode).toBe(400);
  });
});
