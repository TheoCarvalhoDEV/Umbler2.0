import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, settings } from '../../src/db/schema.js';
import { assumeChat, closeChat, reopenChat, setChatPrivacy, transferChat } from '../../src/inbox/chats.js';
import { canSee } from '../../src/inbox/visibility.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
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

describe('assumeChat', () => {
  it('makes me the owner, records assigned and publishes', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    ctx.hub.events.length = 0;
    const chat = await assumeChat(ctx, s.agentA, id);
    expect(chat.ownerId).toBe(s.agentA.id);
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({ kind: 'assigned', authorId: s.agentA.id, data: { ownerId: s.agentA.id, previousOwnerId: null } });
    expect(published(id)).toBe(true);
  });

  it('404 for a chat of another sector, 409 for a closed chat', async () => {
    const other = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    const closed = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    expect(await statusOf(assumeChat(ctx, s.agentA, other))).toBe(404);
    expect(await statusOf(assumeChat(ctx, s.agentA, closed))).toBe(409);
  });
});

describe('a human taking the chat ends a pending triage', () => {
  const armed = async (ownerId: string | null = null) => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId });
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, id));
    return id;
  };

  it('assume clears triage_pending', async () => {
    expect((await assumeChat(ctx, s.agentA, await armed())).triagePending).toBe(false);
  });

  it('transfer to a sector (no owner) and to an agent both clear triage_pending', async () => {
    expect((await transferChat(ctx, s.agentA, await armed(), { sectorId: s.sectorB, ownerId: null })).triagePending).toBe(false);
    expect((await transferChat(ctx, s.agentA, await armed(s.agentA.id), { ownerId: s.agentB.id })).triagePending).toBe(false);
  });
});

describe('transferChat', () => {
  it('moves to another sector, clears owner and privacy, and publishes so the old sector drops it', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, private: true });
    ctx.hub.events.length = 0;
    const chat = await transferChat(ctx, s.agentA, id, { sectorId: s.sectorB, ownerId: null });
    expect(chat).toMatchObject({ sectorId: s.sectorB, ownerId: null, private: false });
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({
      kind: 'transferred',
      authorId: s.agentA.id,
      data: { fromSectorId: s.sectorA, toSectorId: s.sectorB, fromOwnerId: s.agentA.id, toOwnerId: null },
    });
    expect(published(id)).toBe(true);
    expect(canSee(s.agentA, chat)).toBe(false);
    expect(canSee(s.agentB, chat)).toBe(true);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: s.sectorA }))).toBe(404);
  });

  it('hands the chat to another agent and keeps the sector', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    const chat = await transferChat(ctx, s.agentA, id, { ownerId: s.agentB.id });
    expect(chat).toMatchObject({ sectorId: s.sectorA, ownerId: s.agentB.id });
  });

  it('400 for empty target, unknown sector or unknown agent; 409 for a closed chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const closed = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    expect(await statusOf(transferChat(ctx, s.agentA, id, {}))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: randomUUID() }))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: 'x' }))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { ownerId: randomUUID() }))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, closed, { sectorId: s.sectorB }))).toBe(409);
  });
});

describe('setChatPrivacy', () => {
  it('owner makes the chat private and back, recording privacy_changed', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    ctx.hub.events.length = 0;
    expect((await setChatPrivacy(ctx, s.agentA, id, true)).private).toBe(true);
    expect(published(id)).toBe(true);
    expect((await setChatPrivacy(ctx, s.agentA, id, false)).private).toBe(false);
    const evs = await eventsOf(ctx, id);
    expect(evs.map((e) => [e.kind, e.data])).toEqual([
      ['privacy_changed', { private: true }],
      ['privacy_changed', { private: false }],
    ]);
  });

  it('403 for a sector colleague who is not the owner; admin may', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id });
    expect(await statusOf(setChatPrivacy(ctx, s.agentA, id, true))).toBe(403);
    expect((await setChatPrivacy(ctx, s.admin, id, true)).private).toBe(true);
  });

  it('400 when the chat has no owner', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    expect(await statusOf(setChatPrivacy(ctx, s.admin, id, true))).toBe(400);
  });
});

describe('private chats', () => {
  it('a sector colleague cannot transfer or close it (404); admin can close it', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id, private: true });
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: s.sectorB }))).toBe(404);
    expect(await statusOf(closeChat(ctx, s.agentA, id, { sendClosingMessage: false }))).toBe(404);
    expect((await closeChat(ctx, s.admin, id, { sendClosingMessage: false })).state).toBe('closed');
  });
});

describe('closeChat', () => {
  it('closes without sending when not asked', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const sendClosing = vi.fn(async (_text: string) => true);
    ctx.hub.events.length = 0;
    const chat = await closeChat(ctx, s.agentA, id, { sendClosingMessage: false, sendClosing });
    expect(chat.state).toBe('closed');
    expect(chat.closedAt).toBeInstanceOf(Date);
    expect(chat.waiting).toBe(false);
    expect(sendClosing).not.toHaveBeenCalled();
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({ kind: 'closed', authorId: s.agentA.id, data: { closingMessageSent: false } });
    expect(published(id)).toBe(true);
  });

  it('sends settings.closing_message while the chat is still open, then closes', async () => {
    const text = 'Obrigado pelo contato!';
    await ctx.db
      .insert(settings)
      .values({ key: 'closing_message', value: text })
      .onConflictDoUpdate({ target: settings.key, set: { value: text } });
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const seen: string[] = [];
    const sendClosing = async (t: string) => {
      const [c] = await ctx.db.select().from(chats).where(eq(chats.id, id));
      seen.push(`${c!.state}:${t}`);
      return true;
    };
    const chat = await closeChat(ctx, s.agentA, id, { sendClosingMessage: true, sendClosing });
    expect(seen).toEqual(['open:Obrigado pelo contato!']);
    expect(chat.state).toBe('closed');
    const [ev] = await eventsOf(ctx, id);
    expect(ev?.data).toEqual({ closingMessageSent: true });
  });

  it('409 and stays open when the closing message was not sent', async () => {
    await ctx.db
      .insert(settings)
      .values({ key: 'closing_message', value: 'Tchau' })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'Tchau' } });
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    expect(await statusOf(closeChat(ctx, s.agentA, id, { sendClosingMessage: true, sendClosing: async () => false }))).toBe(409);
    const [c] = await ctx.db.select().from(chats).where(eq(chats.id, id));
    expect(c!.state).toBe('open');
    expect(await eventsOf(ctx, id)).toHaveLength(0);
  });

  it('409 when already closed', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    expect(await statusOf(closeChat(ctx, s.agentA, id, { sendClosingMessage: false }))).toBe(409);
  });
});

describe('reopenChat', () => {
  it('reopens a closed chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    ctx.hub.events.length = 0;
    const chat = await reopenChat(ctx, s.agentA, id);
    expect(chat).toMatchObject({ id, state: 'open', closedAt: null });
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({ kind: 'reopened', authorId: s.agentA.id });
    expect(published(id)).toBe(true);
  });

  it('returns the other open chat of the same contact instead of reopening', async () => {
    const contactId = await newContact(ctx);
    const closed = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    const open = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA });
    const chat = await reopenChat(ctx, s.agentA, closed);
    expect(chat.id).toBe(open);
    const [old] = await ctx.db.select().from(chats).where(eq(chats.id, closed));
    expect(old!.state).toBe('closed');
  });

  it('409 when the other open chat is invisible to me', async () => {
    const contactId = await newContact(ctx);
    const closed = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(reopenChat(ctx, s.agentA, closed))).toBe(409);
  });

  it('409 when the chat is already open', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    expect(await statusOf(reopenChat(ctx, s.agentA, id))).toBe(409);
  });
});
