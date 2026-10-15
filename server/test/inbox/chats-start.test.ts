import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats, contacts } from '../../src/db/schema.js';
import { markChatRead, pinChat, startChat, transferChat } from '../../src/inbox/chats.js';
import { enableSeeAll, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat, newContact, statusOf } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

function published(chatId: string): boolean {
  return ctx.hub.events.some((e) => e.chatId === chatId);
}

describe('markChatRead', () => {
  it('zeroes unread and publishes only when something changed', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, unread: 5 });
    ctx.hub.events.length = 0;
    await markChatRead(ctx, s.agentA, id);
    const [row] = await ctx.db.select().from(chats).where(eq(chats.id, id));
    expect(row!.unread).toBe(0);
    expect(published(id)).toBe(true);

    ctx.hub.events.length = 0;
    await markChatRead(ctx, s.agentA, id);
    expect(published(id)).toBe(false);
  });

  it('404 for an invisible chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, unread: 2 });
    expect(await statusOf(markChatRead(ctx, s.agentA, id))).toBe(404);
  });
});

describe('pinChat', () => {
  it('allows 3 pins, rejects the 4th with 409, and unpinning frees a slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
    for (const id of ids.slice(0, 3)) await pinChat(ctx, s.agentA, id, true);
    await pinChat(ctx, s.agentA, ids[0]!, true); // pinning again is a no-op, not a 4th pin
    expect(await statusOf(pinChat(ctx, s.agentA, ids[3]!, true))).toBe(409);

    ctx.hub.events.length = 0;
    await pinChat(ctx, s.agentA, ids[0]!, false);
    expect(published(ids[0]!)).toBe(true);
    await pinChat(ctx, s.agentA, ids[3]!, true);
  });

  it('pins of chats that left my view do not count toward the limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
    for (const id of ids.slice(0, 3)) await pinChat(ctx, s.agentA, id, true);
    await transferChat(ctx, await enableSeeAll(ctx, s.admin), ids[0]!, { sectorId: s.sectorB });
    await pinChat(ctx, s.agentA, ids[3]!, true);
  });

  it('pins are per user', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
    for (const id of ids.slice(0, 3)) await pinChat(ctx, s.agentA, id, true);
    await pinChat(ctx, await enableSeeAll(ctx, s.admin), ids[3]!, true);
  });

  it('404 for an invisible chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(pinChat(ctx, s.agentA, id, true))).toBe(404);
  });
});

describe('startChat', () => {
  it('opens a chat for an existing contact, owned by me, in the default sector, without waiting/triage', async () => {
    const contactId = await newContact(ctx);
    ctx.hub.events.length = 0;
    const chat = await startChat(ctx, s.agentA, { contactId });
    expect(chat).toMatchObject({
      contactId,
      channelId: s.channelId,
      sectorId: s.defaultSector,
      ownerId: s.agentA.id,
      state: 'open',
      waiting: false,
      triagePending: false,
    });
    const [ev] = await eventsOf(ctx, chat.id);
    expect(ev).toMatchObject({ kind: 'created', data: { by: s.agentA.id }, authorId: s.agentA.id });
    expect(published(chat.id)).toBe(true);
  });

  it('uses the requested sector', async () => {
    const contactId = await newContact(ctx);
    const chat = await startChat(ctx, s.agentA, { contactId, sectorId: s.sectorB });
    expect(chat.sectorId).toBe(s.sectorB);
  });

  it('creates the contact for a new phone, normalized to 13 digits', async () => {
    const chat = await startChat(ctx, s.agentA, { phone: '+55 65 9999-8888', name: 'Maria' });
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, chat.contactId));
    expect(c).toMatchObject({ phone: '5565999998888', name: 'Maria' });
  });

  it('a 12-digit phone reaches the contact stored with 13 digits', async () => {
    const contactId = await newContact(ctx, { phone: '5565999997777' });
    const chat = await startChat(ctx, s.agentA, { phone: '556599997777' });
    expect(chat.contactId).toBe(contactId);
    expect(await ctx.db.select().from(contacts).where(eq(contacts.phone, '5565999997777'))).toHaveLength(1);
  });

  it('returns the already open chat instead of opening another', async () => {
    const contactId = await newContact(ctx);
    const existing = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id });
    const chat = await startChat(ctx, s.agentA, { contactId });
    expect(chat.id).toBe(existing);
    expect(chat.ownerId).toBe(s.agentB.id);
    expect(await ctx.db.select().from(chats).where(eq(chats.contactId, contactId))).toHaveLength(1);
  });

  it('409 when the open chat is in a sector I cannot see', async () => {
    const contactId = await newContact(ctx);
    await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(startChat(ctx, s.agentA, { contactId }))).toBe(409);
  });

  it('validates the input', async () => {
    expect(await statusOf(startChat(ctx, s.agentA, {}))).toBe(400);
    expect(await statusOf(startChat(ctx, s.agentA, { phone: '123' }))).toBe(400);
    expect(await statusOf(startChat(ctx, s.agentA, { contactId: randomUUID() }))).toBe(404);
    expect(await statusOf(startChat(ctx, s.agentA, { contactId: 'x' }))).toBe(404);
    expect(await statusOf(startChat(ctx, s.agentA, { phone: '65999998888', sectorId: randomUUID() }))).toBe(400);
  });
});
