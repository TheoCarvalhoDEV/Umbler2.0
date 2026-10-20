import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BulkResultDto } from '@talk/shared';
import { botRuns, chats, messages, settings } from '../../src/db/schema.js';
import { seedWaitingRun, setupActions, type ActionsWorld } from '../messages/actions-seed.js';
import { seedChat, type SeedChatOpts } from './seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions(); // agentA's open chat w.chatId (sector A, owner agentA)
});
afterEach(async () => {
  await w.app.close();
});

let n = 0;
/** Another chat of agentA in sector A, with its own phone contact. */
const another = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(w.ctx, {
    channelId: w.s.channelId, sectorId: w.s.sectorA, ownerId: w.s.agentA.id, phone: `5565988880${String(++n).padStart(3, '0')}`, ...o,
  });
/** A chat agentA cannot see (sector B, nobody's). */
const hiddenChat = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5511988887777', ...o });
const bulk = (action: 'transfer' | 'close' | 'read', payload: object, headers: Record<string, string> = w.headers) =>
  w.app.inject({ method: 'POST', url: `/api/chats/bulk/${action}`, headers, payload });
const chatRow = async (id: string) => (await w.ctx.db.select().from(chats).where(eq(chats.id, id)))[0]!;
const runStates = async (chatId: string) =>
  (await w.ctx.db.select().from(botRuns).where(eq(botRuns.chatId, chatId))).map((r) => r.state);
async function setSetting(key: string, value: string) {
  await w.ctx.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

describe('POST /api/chats/bulk/* (spec 2026-10-20 §4)', () => {
  it('transfers each chat it can and tells why the others could not (Review Focus 4)', async () => {
    const open2 = (await another()).chatId;
    const closed = (await another({ state: 'closed' })).chatId;
    const hidden = (await hiddenChat()).chatId;

    const res = await bulk('transfer', { chatIds: [w.chatId, open2, closed, hidden, w.chatId], sectorId: w.s.defaultSector });

    expect(res.statusCode).toBe(200);
    expect(res.json() as BulkResultDto).toEqual({
      done: [w.chatId, open2],
      failed: [
        { chatId: closed, error: 'Conversa finalizada' },
        { chatId: hidden, error: 'Conversa não encontrada' },
      ],
    });
    expect((await chatRow(w.chatId)).sectorId).toBe(w.s.defaultSector);
    expect((await chatRow(open2)).sectorId).toBe(w.s.defaultSector);
    expect((await chatRow(hidden)).sectorId).toBe(w.s.sectorB);
    expect(w.ctx.hub.events).not.toContainEqual({ type: 'chat', chatId: hidden });
  });

  it('stops a running chatbot under "Perguntar" instead of asking, and keeps it under "Manter" (Review Focus 4)', async () => {
    await seedWaitingRun(w); // default behavior: ask
    expect((await bulk('transfer', { chatIds: [w.chatId], sectorId: w.s.sectorB })).json()).toEqual({ done: [w.chatId], failed: [] });
    expect(await runStates(w.chatId)).toEqual(['stopped']);

    await setSetting('bot_running_behavior', 'keep');
    const other = await another();
    await seedWaitingRun(w, other.chatId, other.contactId);
    expect((await bulk('transfer', { chatIds: [other.chatId], sectorId: w.s.sectorB })).json()).toEqual({
      done: [other.chatId], failed: [],
    });
    expect(await runStates(other.chatId)).toEqual(['waiting_reply']);
  });

  it('a destination that does not exist is one 400, and nothing changes, not even a chatbot', async () => {
    await seedWaitingRun(w);

    expect((await bulk('transfer', { chatIds: [w.chatId], sectorId: randomUUID() })).statusCode).toBe(400);
    expect((await bulk('transfer', { chatIds: [w.chatId], ownerId: randomUUID() })).statusCode).toBe(400);
    expect((await bulk('transfer', { chatIds: [w.chatId] })).statusCode).toBe(400);

    expect((await chatRow(w.chatId)).sectorId).toBe(w.s.sectorA);
    expect(await runStates(w.chatId)).toEqual(['waiting_reply']);
  });

  it('closes in bulk with one closing-message choice; a failed send keeps that chat open (Review Focus 5)', async () => {
    await setSetting('closing_message', 'Obrigado pelo contato!');
    const other = await another();
    await seedWaitingRun(w, other.chatId, other.contactId);
    w.ctx.wa.failNext(new Error('Evolution fora do ar')); // the first chat's closing message

    const res = await bulk('close', { chatIds: [w.chatId, other.chatId], sendClosingMessage: true });

    expect(res.json()).toEqual({
      done: [other.chatId],
      failed: [{ chatId: w.chatId, error: 'Mensagem de encerramento não enviada; a conversa continua aberta' }],
    });
    expect((await chatRow(w.chatId)).state).toBe('open');
    expect(await chatRow(other.chatId)).toMatchObject({ state: 'closed', waitingSince: null });
    const closing = await w.ctx.db.select().from(messages).where(eq(messages.body, 'Obrigado pelo contato!'));
    const statusOf = new Map(closing.map((m) => [m.chatId, m.status]));
    expect(statusOf.get(w.chatId)).toBe('failed'); // the bubble stays, to be resent
    expect(statusOf.get(other.chatId)).not.toBe('failed');
    expect(await runStates(other.chatId)).toEqual(['stopped']);
  });

  it('marks read in bulk only the chats the user sees', async () => {
    await w.ctx.db.update(chats).set({ unread: 3 }).where(eq(chats.id, w.chatId));
    const hidden = (await hiddenChat({ unread: 2 })).chatId;

    expect((await bulk('read', { chatIds: [w.chatId, hidden] })).json()).toEqual({
      done: [w.chatId],
      failed: [{ chatId: hidden, error: 'Conversa não encontrada' }],
    });
    expect((await chatRow(w.chatId)).unread).toBe(0);
    expect((await chatRow(hidden)).unread).toBe(2);
  });

  it('refuses more than 50 chats, an empty list and a request without Origin', async () => {
    expect((await bulk('read', { chatIds: Array.from({ length: 51 }, () => randomUUID()) })).statusCode).toBe(400);
    expect((await bulk('close', { chatIds: [] })).statusCode).toBe(400);
    expect((await bulk('read', { chatIds: [w.chatId] }, { cookie: w.headers.cookie! })).statusCode).toBe(403);
  });
});
