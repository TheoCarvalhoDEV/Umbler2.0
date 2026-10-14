import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats } from '../../src/db/schema.js';
import { findOrOpenChat, getChatForUser, getDefaultSectorId } from '../../src/inbox/chats.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat, newContact, statusOf } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

describe('getDefaultSectorId', () => {
  it('returns the sector flagged is_default', async () => {
    expect(await getDefaultSectorId(ctx.db)).toBe(s.defaultSector);
  });
});

describe('findOrOpenChat', () => {
  it('creates an open chat with the init fields and a created event with the author', async () => {
    const contactId = await newContact(ctx);
    const { chat, created } = await findOrOpenChat(ctx.db, {
      contactId,
      channelId: s.channelId,
      init: { sectorId: s.sectorA, ownerId: s.agentA.id, waiting: false, triagePending: false, createdBy: s.agentA.id },
    });
    expect(created).toBe(true);
    expect(chat).toMatchObject({
      contactId,
      channelId: s.channelId,
      sectorId: s.sectorA,
      ownerId: s.agentA.id,
      state: 'open',
      waiting: false,
      private: false,
      triagePending: false,
      unread: 0,
    });
    const events = await eventsOf(ctx, chat.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'created', data: { by: s.agentA.id }, authorId: s.agentA.id });
  });

  it('reuses the open chat instead of creating a second one (inbound init, no author)', async () => {
    const contactId = await newContact(ctx);
    const init = { sectorId: s.defaultSector, ownerId: null, waiting: true, triagePending: true, createdBy: null };
    const first = await findOrOpenChat(ctx.db, { contactId, channelId: s.channelId, init });
    const second = await findOrOpenChat(ctx.db, { contactId, channelId: s.channelId, init: { ...init, sectorId: s.sectorB } });

    expect(first.created).toBe(true);
    expect(first.chat).toMatchObject({ waiting: true, triagePending: true, ownerId: null });
    expect(second.created).toBe(false);
    expect(second.chat.id).toBe(first.chat.id);
    expect(second.chat.sectorId).toBe(s.defaultSector);
    expect(await ctx.db.select().from(chats).where(eq(chats.contactId, contactId))).toHaveLength(1);

    const events = await eventsOf(ctx, first.chat.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'created', data: {}, authorId: null });
  });

  it('opens a new chat when the previous one is closed', async () => {
    const contactId = await newContact(ctx);
    const oldId = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    const { chat, created } = await findOrOpenChat(ctx.db, {
      contactId,
      channelId: s.channelId,
      init: { sectorId: s.defaultSector, ownerId: null, waiting: true, triagePending: false, createdBy: null },
    });
    expect(created).toBe(true);
    expect(chat.id).not.toBe(oldId);
  });
});

describe('getChatForUser', () => {
  it('returns a visible chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    expect((await getChatForUser(ctx, s.agentA, id)).id).toBe(id);
    expect((await getChatForUser(ctx, s.admin, id)).id).toBe(id);
  });

  it('404 for an invisible, unknown or malformed id', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(getChatForUser(ctx, s.agentA, id))).toBe(404);
    expect(await statusOf(getChatForUser(ctx, s.agentA, randomUUID()))).toBe(404);
    expect(await statusOf(getChatForUser(ctx, s.agentA, 'nao-e-uuid'))).toBe(404);
  });
});
