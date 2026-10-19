import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WsEvent } from '@talk/shared';
import type { NotificationDto } from '@talk/shared';
import type { AppCtx } from '../../src/ctx.js';
import { channels, chatPins, chats, contactTags, contacts, messages, tags, userSectors, users } from '../../src/db/schema.js';
import { transferChat } from '../../src/inbox/chats.js';
import { createHub, createRecordingHub, type Hub } from '../../src/realtime/hub.js';
import { enableSeeAll, makeTestCtx, seedBasics } from '../helpers.js';

type Seed = Awaited<ReturnType<typeof seedBasics>>;

function fakeSocket() {
  const socket = {
    events: [] as WsEvent[],
    closed: false,
    send(data: string) { socket.events.push(JSON.parse(data) as WsEvent); },
    close() { socket.closed = true; },
  };
  return socket;
}

let phoneSeq = 0;
async function insertChat(ctx: AppCtx, channelId: string, init: { sectorId: string; ownerId?: string | null; private?: boolean }) {
  const contactId = randomUUID();
  const phone = `55659${String(++phoneSeq).padStart(8, '0')}`;
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria Souza', phone });
  const [chat] = await ctx.db.insert(chats).values({
    id: randomUUID(), contactId, channelId, sectorId: init.sectorId, ownerId: init.ownerId ?? null,
    state: 'open', waiting: true, private: init.private ?? false, triagePending: false, unread: 1,
    lastMessageAt: new Date('2026-10-14T12:00:00Z'), lastMessagePreview: 'Olá',
  }).returning();
  return { chat, contactId, phone };
}

let ctx: AppCtx;
let s: Seed;
let hub: Hub;

beforeEach(async () => {
  const base = await makeTestCtx();
  s = await seedBasics(base);
  ctx = base;
  hub = createHub(() => base.db);
});

describe('createHub.publishChat', () => {
  it('sends chat.updated to users who can see the chat and chat.removed to the rest, recomputed after a transfer', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    await enableSeeAll(ctx, s.admin);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });

    await hub.publishChat(chat.id);

    expect(a.events).toEqual([{ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id, sectorId: s.sectorA }) }]);
    expect(adm.events).toEqual([{ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id }) }]);
    expect(b.events).toEqual([{ type: 'chat.removed', chatId: chat.id }]);

    // Transfer to sector B (done directly in the DB; the hub must recompute visibility from the DB).
    await ctx.db.update(chats).set({ sectorId: s.sectorB }).where(eq(chats.id, chat.id));
    await hub.publishChat(chat.id);

    expect(a.events[1]).toEqual({ type: 'chat.removed', chatId: chat.id });
    expect(b.events[1]).toEqual({ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id, sectorId: s.sectorB }) });
    expect(adm.events[1]).toEqual({ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id, sectorId: s.sectorB }) });
  });

  it('sends the full ChatListItem with per-user pinned flag and contact tags', async () => {
    const a = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.admin, adm);
    await enableSeeAll(ctx, s.admin);
    const { chat, contactId, phone } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    const tagId = randomUUID();
    await ctx.db.insert(tags).values({ id: tagId, name: 'Cliente', emoji: null, color: '#22c55e', position: 0 });
    await ctx.db.insert(contactTags).values({ contactId, tagId });
    await ctx.db.insert(chatPins).values({ userId: s.agentA.id, chatId: chat.id });

    await hub.publishChat(chat.id);

    const expected = {
      id: chat.id,
      contact: { id: contactId, name: 'Maria Souza', phone, avatarUrl: null },
      channelId: s.channelId,
      sectorId: s.sectorA,
      ownerId: null,
      state: 'open',
      waiting: true,
      private: false,
      unread: 1,
      lastMessageAt: '2026-10-14T12:00:00.000Z',
      lastMessagePreview: 'Olá',
      pinned: true,
      tagIds: [tagId],
    };
    expect(a.events).toEqual([{ type: 'chat.updated', chat: expected }]);
    expect(adm.events).toEqual([{ type: 'chat.updated', chat: { ...expected, pinned: false } }]);
  });

  it('holds an admin without "ver todos" to the sector barrier: chat.removed after a transfer out of his sector', async () => {
    const adm = fakeSocket();
    hub.register(s.admin, adm);
    await ctx.db.insert(userSectors).values({ userId: s.admin.id, sectorId: s.sectorA });
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });

    await hub.publishChat(chat.id);
    await ctx.db.update(chats).set({ sectorId: s.sectorB }).where(eq(chats.id, chat.id));
    await hub.publishChat(chat.id);
    // The preference is read from the DB on every publish, like the sectors.
    await ctx.db.update(users).set({ seeAllSectors: true }).where(eq(users.id, s.admin.id));
    await hub.publishChat(chat.id);

    expect(adm.events.map((e) => e.type)).toEqual(['chat.updated', 'chat.removed', 'chat.updated']);
  });

  it('a transfer through the real service sends chat.removed to the admin without "ver todos" and chat.updated to the target sector', async () => {
    const adm = fakeSocket(); const b = fakeSocket();
    hub.register(s.admin, adm); hub.register(s.agentB, b);
    await ctx.db.insert(userSectors).values({ userId: s.admin.id, sectorId: s.sectorA });
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });

    await transferChat({ ...ctx, hub }, s.agentA, chat.id, { sectorId: s.sectorB });

    expect(adm.events).toEqual([{ type: 'chat.removed', chatId: chat.id }]);
    expect(b.events).toEqual([{ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id, sectorId: s.sectorB }) }]);
  });

  it('sends a private chat only to its owner and admins with "ver todos", even to members of its sector', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    await enableSeeAll(ctx, s.admin);
    // Chat in sector B (agentB's sector) but private to agentA.
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorB, ownerId: s.agentA.id, private: true });

    await hub.publishChat(chat.id);

    expect(a.events.map((e) => e.type)).toEqual(['chat.updated']);
    expect(adm.events.map((e) => e.type)).toEqual(['chat.updated']);
    expect(b.events).toEqual([{ type: 'chat.removed', chatId: chat.id }]);
  });
});

describe('createHub.publishMessage', () => {
  it('sends the MessageDto only to sockets whose user can see the chat', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    await enableSeeAll(ctx, s.admin);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    const messageId = randomUUID();
    await ctx.db.insert(messages).values({
      id: messageId, chatId: chat.id, channelId: s.channelId, direction: 'out', kind: 'text', body: 'Bom dia',
      authorId: s.agentA.id, status: 'sent', sentAt: new Date('2026-10-14T12:01:00Z'),
    });

    await hub.publishMessage(chat.id, 'message.created', messageId);

    const message = {
      id: messageId, chatId: chat.id, direction: 'out', kind: 'text', body: 'Bom dia',
      media: null, mediaUnavailable: false, mediaExpired: false, authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
      officeReaction: null, deleted: null, edited: null, forwarded: false,
      replyTo: null, reaction: null, status: 'sent', error: null, sentAt: '2026-10-14T12:01:00.000Z',
    };
    expect(a.events).toEqual([{ type: 'message.created', message }]);
    expect(adm.events).toEqual([{ type: 'message.created', message }]);
    expect(b.events).toEqual([]);

    await ctx.db.update(messages).set({ status: 'read' }).where(eq(messages.id, messageId));
    await hub.publishMessage(chat.id, 'message.updated', messageId);

    expect(a.events[1]).toEqual({ type: 'message.updated', message: { ...message, status: 'read' } });
    expect(b.events).toEqual([]);
  });
});

describe('createHub.publishChannel', () => {
  it('sends channel.status to every connected socket', async () => {
    const a = fakeSocket(); const b = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b);
    await ctx.db.update(channels).set({ status: 'connected', phone: '5565999990000' }).where(eq(channels.id, s.channelId));
    const [row] = await ctx.db.select().from(channels).where(eq(channels.id, s.channelId));

    await hub.publishChannel(s.channelId);

    const event = { type: 'channel.status', channel: { id: row.id, name: row.name, status: 'connected', phone: '5565999990000' } };
    expect(a.events).toEqual([event]);
    expect(b.events).toEqual([event]);
  });
});

describe('createHub.publishUsersChanged', () => {
  it('sends users.changed to every connected socket, whatever the sector', () => {
    const a1 = fakeSocket(); const a2 = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a1); hub.register(s.agentA, a2); hub.register(s.agentB, b); hub.register(s.admin, adm);

    hub.publishUsersChanged();

    for (const socket of [a1, a2, b, adm]) expect(socket.events).toEqual([{ type: 'users.changed' }]);
  });
});

describe('createHub.register / disconnectUser', () => {
  it('disconnectUser closes every socket of that user and stops delivery to them', async () => {
    const a1 = fakeSocket(); const a2 = fakeSocket(); const b = fakeSocket();
    hub.register(s.agentA, a1); hub.register(s.agentA, a2); hub.register(s.agentB, b);

    hub.disconnectUser(s.agentA.id);

    expect(a1.closed).toBe(true);
    expect(a2.closed).toBe(true);
    expect(b.closed).toBe(false);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    await hub.publishChat(chat.id);
    expect(a1.events).toEqual([]);
    expect(a2.events).toEqual([]);
    expect(b.events).toEqual([{ type: 'chat.removed', chatId: chat.id }]);
  });

  it('the function returned by register stops delivery to that socket only', async () => {
    const a1 = fakeSocket(); const a2 = fakeSocket();
    const unregister = hub.register(s.agentA, a1);
    hub.register(s.agentA, a2);

    unregister();
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    await hub.publishChat(chat.id);

    expect(a1.events).toEqual([]);
    expect(a2.events.map((e) => e.type)).toEqual(['chat.updated']);
  });
});

describe('createRecordingHub', () => {
  it('records every call with the shapes other tasks assert on', async () => {
    const rec = createRecordingHub();
    await rec.publishChat('c1');
    await rec.publishMessage('c1', 'message.created', 'm1');
    await rec.publishMessage('c1', 'message.updated', 'm1');
    await rec.publishChannel('ch1');
    rec.publishUsersChanged();
    rec.disconnectUser('u1');
    rec.register(s.agentA, fakeSocket())();

    expect(rec.events).toEqual([
      { type: 'chat', chatId: 'c1' },
      { type: 'message.created', chatId: 'c1', messageId: 'm1' },
      { type: 'message.updated', chatId: 'c1', messageId: 'm1' },
      { type: 'channel', channelId: 'ch1' },
      { type: 'users.changed' },
      { type: 'disconnect', userId: 'u1' },
    ]);
  });

  it('is the hub makeTestCtx provides', async () => {
    const t = await makeTestCtx();
    await t.hub.publishChat('x');
    expect(t.hub.events).toEqual([{ type: 'chat', chatId: 'x' }]);
  });
});

describe('publishNotification', () => {
  it('real hub sends the notification once, only to listed users who can see the chat', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    await enableSeeAll(ctx, s.admin);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    const notification: NotificationDto = {
      id: randomUUID(), chatId: chat.id, title: 'Nova conversa', text: 'Nova conversa de Maria Souza',
      botName: 'Fluxo do escritório', createdAt: '2026-10-14T13:00:00.000Z',
    };

    await hub.publishNotification(chat.id, [s.agentA.id, s.agentB.id, s.agentA.id], notification);

    expect(a.events).toEqual([{ type: 'notification', notification }]); // listed twice, delivered once
    expect(b.events).toEqual([]);   // listed, but a sector B agent cannot see a sector A chat
    expect(adm.events).toEqual([]); // sees every chat, but was not listed
  });

  it('recording hub records one event per listed user', async () => {
    const rec = createRecordingHub();
    const n: NotificationDto = { id: 'n1', chatId: 'c1', title: 't', text: 'x', botName: 'B', createdAt: '2026-10-14T13:00:00.000Z' };
    await rec.publishNotification('c1', ['u1', 'u2'], n);
    expect(rec.events).toEqual([
      { type: 'notification', chatId: 'c1', userId: 'u1' },
      { type: 'notification', chatId: 'c1', userId: 'u2' },
    ]);
  });
});
