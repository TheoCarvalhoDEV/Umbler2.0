import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatEvents, chatPins, chats, contacts, deletedChats, messages, scheduledMessages } from '../../src/db/schema.js';
import { placeRecords } from '../../src/history/place.js';
import { deleteChat } from '../../src/inbox/chats.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { PHONE, rec } from '../history/records.js';
import { seedChat, seedEvent, seedMessage } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

const chatRow = async (id: string) => (await ctx.db.select().from(chats).where(eq(chats.id, id)))[0];

describe('POST /api/chats/:id/unread', () => {
  it('sets unread to 1 when it was 0 and publishes; keeps 3 as 3', async () => {
    const read = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, unread: 0 });
    const unread = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, unread: 3 });
    const { headers } = await loginAs(app, s.agentA.email);

    const res = await app.inject({ method: 'POST', url: `/api/chats/${read.chatId}/unread`, headers });
    expect(res.statusCode).toBe(204);
    expect((await chatRow(read.chatId))!.unread).toBe(1);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId: read.chatId });

    expect((await app.inject({ method: 'POST', url: `/api/chats/${unread.chatId}/unread`, headers })).statusCode).toBe(204);
    expect((await chatRow(unread.chatId))!.unread).toBe(3);
    expect(ctx.hub.events).not.toContainEqual({ type: 'chat', chatId: unread.chatId });
  });

  it('is 404 for a chat the user cannot see', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    const { headers } = await loginAs(app, s.agentA.email);
    expect((await app.inject({ method: 'POST', url: `/api/chats/${chatId}/unread`, headers })).statusCode).toBe(404);
    expect((await chatRow(chatId))!.unread).toBe(0);
  });
});

describe('DELETE /api/chats/:id', () => {
  async function seedFullChat() {
    const { chatId, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, phone: PHONE });
    await mkdir(join(ctx.config.mediaDir, '2026/10'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, '2026/10/foto.jpg'), 'x');
    await writeFile(join(ctx.config.mediaDir, '2026/10/figurinha.webp'), 'x');
    await mkdir(join(ctx.config.mediaDir, 'bots'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, 'bots/boas-vindas.pdf'), 'x');
    const at = new Date('2026-10-10T12:00:00Z');
    await seedMessage(ctx, chatId, s.channelId, at, { kind: 'image', mediaPath: '2026/10/foto.jpg', externalId: 'M1' });
    await seedMessage(ctx, chatId, s.channelId, at, { kind: 'sticker', mediaPath: '2026/10/figurinha.webp', externalId: 'M2' });
    await seedMessage(ctx, chatId, s.channelId, at, { kind: 'document', mediaPath: 'bots/boas-vindas.pdf', externalId: 'M3' });
    await seedEvent(ctx, chatId, 'created', at);
    // a scheduled message's file (any state) goes with the chat
    await writeFile(join(ctx.config.mediaDir, '2026/10/agendado.pdf'), 'x');
    await ctx.db.insert(scheduledMessages).values({
      chatId, authorId: s.agentA.id, body: 'Lembrete', signature: false, sendAt: at, status: 'canceled', mediaPath: '2026/10/agendado.pdf',
    });
    await ctx.db.insert(chatPins).values({ userId: s.agentA.id, chatId });
    // the same sticker file, resent in another chat, must survive
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    await seedMessage(ctx, other.chatId, s.channelId, at, { kind: 'sticker', mediaPath: '2026/10/figurinha.webp' });
    return { chatId, contactId };
  }

  it('is 403 for an agent, even on a chat he sees', async () => {
    const { chatId } = await seedFullChat();
    const { headers } = await loginAs(app, s.agentA.email);
    const res = await app.inject({ method: 'DELETE', url: `/api/chats/${chatId}`, headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Só administradores podem excluir conversas.');
    expect(await chatRow(chatId)).toBeDefined();
  });

  it('is 404 for a chat the admin cannot see', async () => {
    const { chatId } = await seedFullChat(); // admin has no sectors and no "ver todos"
    const { headers } = await loginAs(app, s.admin.email);
    expect((await app.inject({ method: 'DELETE', url: `/api/chats/${chatId}`, headers })).statusCode).toBe(404);
    expect(await chatRow(chatId)).toBeDefined();
  });

  it('an admin deletes the chat, its messages, events, pins and own media; the contact stays; a tombstone is written', async () => {
    const { chatId, contactId } = await seedFullChat();
    await enableSeeAll(ctx, s.admin);
    const { headers } = await loginAs(app, s.admin.email);

    const res = await app.inject({ method: 'DELETE', url: `/api/chats/${chatId}`, headers });
    expect(res.statusCode).toBe(204);

    expect(await chatRow(chatId)).toBeUndefined();
    expect(await ctx.db.select().from(messages).where(eq(messages.chatId, chatId))).toEqual([]);
    expect(await ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chatId))).toEqual([]);
    expect(await ctx.db.select().from(chatPins).where(eq(chatPins.chatId, chatId))).toEqual([]);
    expect(await ctx.db.select().from(contacts).where(eq(contacts.id, contactId))).toHaveLength(1);
    expect(existsSync(join(ctx.config.mediaDir, '2026/10/foto.jpg'))).toBe(false);
    expect(existsSync(join(ctx.config.mediaDir, '2026/10/agendado.pdf'))).toBe(false);
    expect(existsSync(join(ctx.config.mediaDir, '2026/10/figurinha.webp'))).toBe(true); // still used by the other chat
    expect(existsSync(join(ctx.config.mediaDir, 'bots/boas-vindas.pdf'))).toBe(true); // chatbot library file
    expect(ctx.hub.events).toContainEqual({ type: 'chat.removed', chatId });

    const [tomb] = await ctx.db.select().from(deletedChats);
    expect(tomb).toMatchObject({ contactId, channelId: s.channelId, deletedBy: s.admin.id, until: ctx.botRuntime.now() });
    expect(console.info).toHaveBeenCalledWith('chat deleted', { chatId, userId: s.admin.id });
  });
});

describe('deleteChat tombstone', () => {
  it('covers a message stamped after the server clock (phone clock ahead)', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, phone: PHONE });
    const ahead = new Date(ctx.botRuntime.now().getTime() + 5 * 60_000);
    await seedMessage(ctx, chatId, s.channelId, ahead, { externalId: 'AHEAD' });
    await deleteChat(ctx, await enableSeeAll(ctx, s.admin), chatId);
    const [tomb] = await ctx.db.select().from(deletedChats);
    expect(tomb?.until).toEqual(ahead);
  });
});

describe('after a chat is deleted', () => {
  async function deleteSeeded() {
    const { chatId, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, phone: PHONE });
    await seedMessage(ctx, chatId, s.channelId, new Date('2026-10-10T12:00:00Z'), { externalId: 'OLD1' });
    await deleteChat(ctx, await enableSeeAll(ctx, s.admin), chatId);
    return contactId;
  }

  it('a history import skips the contact’s older rows on the channel but places newer ones and other contacts', async () => {
    const contactId = await deleteSeeded();
    const r = await placeRecords(
      ctx,
      { id: s.channelId, evolutionInstance: s.instance },
      [
        rec({ id: 'OLD1', at: '2026-10-10T12:00:00Z' }),
        rec({ id: 'OLD2', at: '2026-10-14T13:00:00Z' }), // exactly at `until`: still before the deletion
        rec({ id: 'NEW1', at: '2026-10-14T14:00:00Z' }),
        rec({ id: 'OTHER1', at: '2026-10-10T12:00:00Z', jid: '556588888888@s.whatsapp.net' }),
      ],
      { names: new Map(), seen: new Set() },
    );
    expect(r.inserted).toBe(2);
    const stored = (await ctx.db.select({ externalId: messages.externalId }).from(messages)).map((m) => m.externalId).sort();
    expect(stored).toEqual(['NEW1', 'OTHER1']);
    expect(await ctx.db.select().from(chats).where(eq(chats.contactId, contactId))).toHaveLength(1); // a history chat for NEW1
  });

  it('a live inbound message from the contact opens a new chat', async () => {
    const contactId = await deleteSeeded();
    const hooks: IngestHooks = { startTriage: async () => {}, handleTriageReply: async () => true };
    const ev: InboundEvent = {
      type: 'message', instance: s.instance, externalId: 'LIVE1', direction: 'in', phone: PHONE, lid: null,
      pushName: 'Cliente', kind: 'text', body: 'oi de novo', hasMedia: false, mediaMime: null, mediaName: null,
      replyToExternalId: null, sentAt: new Date('2026-10-10T12:00:00Z'), raw: {},
    };
    await handleInbound(ctx, [ev], hooks);
    const open = await ctx.db.select().from(chats).where(eq(chats.contactId, contactId));
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe('open');
  });
});
