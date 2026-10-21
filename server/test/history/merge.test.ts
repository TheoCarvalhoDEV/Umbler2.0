import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, deletedChats, messages, scheduledMessages, tags,
} from '../../src/db/schema.js';
import { mergeLidPairs } from '../../src/history/merge.js';
import { placeRecords } from '../../src/history/place.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { seedMessage } from '../chats/seed.js';
import { eventsOf, insertChat, newContact } from '../inbox/fixtures.js';
import { LID, LID_JID, PHONE, PHONE_JID, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

const at = (iso: string) => new Date(iso);
const pair = [{ lid: LID, phone: PHONE }];
const chatById = async (id: string) => (await ctx.db.select().from(chats).where(eq(chats.id, id)))[0];

async function lidOnly(extra: Partial<typeof contacts.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(contacts).values({ id, lid: LID, phone: null, name: null, ...extra });
  return id;
}

describe('mergeLidPairs (§5.4)', () => {
  it('joins the LID-only contact into the phone contact: chats, tags, fields and notes move, phone values win', async () => {
    const lidId = await lidOnly({ name: 'Maria (sem número)', email: 'maria@exemplo.com.br' });
    const phoneId = await newContact(ctx, { phone: PHONE, name: 'Maria' });
    const historyChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, state: 'closed', history: true });
    const [t1, t2] = await ctx.db
      .insert(tags)
      .values([{ name: 'Cliente', color: '#22c55e' }, { name: 'VIP', color: '#ef4444' }])
      .returning({ id: tags.id });
    await ctx.db.insert(contactTags).values([
      { contactId: lidId, tagId: t1!.id },
      { contactId: lidId, tagId: t2!.id },
      { contactId: phoneId, tagId: t1!.id },
    ]);
    const [cpf, origem] = await ctx.db
      .insert(customFields)
      .values([{ name: 'CPF', kind: 'cpf' }, { name: 'Origem', kind: 'text' }])
      .returning({ id: customFields.id });
    await ctx.db.insert(contactFieldValues).values([
      { contactId: lidId, fieldId: cpf!.id, value: '111' },
      { contactId: phoneId, fieldId: cpf!.id, value: '222' },
      { contactId: lidId, fieldId: origem!.id, value: 'Indicação' },
    ]);
    await ctx.db.insert(contactNotes).values({ contactId: lidId, body: 'Ligar à tarde' });

    expect(await mergeLidPairs(ctx, pair)).toBe(1);

    expect(await ctx.db.select().from(contacts).where(eq(contacts.id, lidId))).toEqual([]);
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, phoneId));
    expect(c).toMatchObject({ phone: PHONE, lid: LID, name: 'Maria', email: 'maria@exemplo.com.br' });
    expect((await chatById(historyChat))!.contactId).toBe(phoneId);
    const tagIds = (await ctx.db.select().from(contactTags).where(eq(contactTags.contactId, phoneId))).map((r) => r.tagId);
    expect(tagIds.sort()).toEqual([t1!.id, t2!.id].sort());
    const fields = await ctx.db.select().from(contactFieldValues).where(eq(contactFieldValues.contactId, phoneId));
    expect(new Map(fields.map((f) => [f.fieldId, f.value]))).toEqual(new Map([[cpf!.id, '222'], [origem!.id, 'Indicação']]));
    expect((await ctx.db.select().from(contactNotes))[0]!.contactId).toBe(phoneId);
    expect((await eventsOf(ctx, historyChat)).map((e) => [e.kind, e.data])).toEqual([['contact_merged', {}]]);
  });

  it("with an open chat on both sides, the LID chat's messages go into the phone contact's open chat", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, unread: 1 });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: phoneId, unread: 2 });
    const m1 = await seedMessage(ctx, lidChat, s.channelId, at('2026-10-14T12:30:00Z'), { body: 'pelo LID' });
    await seedMessage(ctx, phoneChat, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'antes' });
    await ctx.db.update(chats).set({ lastMessageAt: at('2026-10-14T12:30:00Z'), lastMessagePreview: 'pelo LID' }).where(eq(chats.id, lidChat));
    await ctx.db.update(chats).set({ lastMessageAt: at('2026-10-14T12:00:00Z'), lastMessagePreview: 'antes' }).where(eq(chats.id, phoneChat));

    await mergeLidPairs(ctx, pair);

    expect(await chatById(lidChat)).toBeUndefined();
    expect((await ctx.db.select().from(messages).where(eq(messages.id, m1)))[0]!.chatId).toBe(phoneChat);
    expect(await chatById(phoneChat)).toMatchObject({
      sectorId: s.sectorA, unread: 3, lastMessageAt: at('2026-10-14T12:30:00Z'), lastMessagePreview: 'pelo LID',
    });
    expect((await eventsOf(ctx, phoneChat)).map((e) => e.kind)).toEqual(['contact_merged']);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId: phoneChat });
  });

  it("an absorbed chat's conversation tags move to the twin (Review Focus 6)", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: phoneId });
    const [t1, t2] = await ctx.db
      .insert(tags)
      .values([{ name: 'Prazo', color: '#ef4444' }, { name: 'Audiência', color: '#2563eb' }])
      .returning({ id: tags.id });
    await ctx.db.insert(chatTags).values([
      { chatId: lidChat, tagId: t1!.id },
      { chatId: lidChat, tagId: t2!.id },
      { chatId: phoneChat, tagId: t1!.id },
    ]);

    await mergeLidPairs(ctx, pair);

    const rows = await ctx.db.select().from(chatTags).where(eq(chatTags.chatId, phoneChat));
    expect(rows.map((r) => r.tagId).sort()).toEqual([t1!.id, t2!.id].sort());
  });

  it("an absorbed chat's scheduled messages move to the twin (spec 2026-10-20 agendamentos §3.3)", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: phoneId });
    await ctx.db.insert(scheduledMessages).values({ chatId: lidChat, authorId: s.agentA.id, body: 'Lembrete', signature: false, sendAt: new Date() });

    await mergeLidPairs(ctx, pair);

    expect((await ctx.db.select().from(scheduledMessages)).map((r) => r.chatId)).toEqual([phoneChat]);
  });

  it('two history chats become one spanning both', async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, state: 'closed', history: true });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: phoneId, state: 'closed', history: true });
    await ctx.db.update(chats).set({ createdAt: at('2026-08-01T10:00:00Z'), closedAt: at('2026-08-05T10:00:00Z') }).where(eq(chats.id, lidChat));
    await ctx.db.update(chats).set({ createdAt: at('2026-09-01T10:00:00Z'), closedAt: at('2026-09-03T10:00:00Z') }).where(eq(chats.id, phoneChat));
    const m1 = await seedMessage(ctx, lidChat, s.channelId, at('2026-08-02T10:00:00Z'));

    await mergeLidPairs(ctx, pair);

    expect(await ctx.db.select().from(chats).where(eq(chats.contactId, phoneId))).toHaveLength(1);
    expect(await chatById(phoneChat)).toMatchObject({ createdAt: at('2026-08-01T10:00:00Z'), closedAt: at('2026-09-03T10:00:00Z') });
    expect((await ctx.db.select().from(messages).where(eq(messages.id, m1)))[0]!.chatId).toBe(phoneChat);
    expect(ctx.hub.events).toContainEqual({ type: 'chat.removed', chatId: lidChat }); // the absorbed chat leaves every client
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId: phoneChat });
  });

  it('without a contact holding that phone, the LID-only contact only gains the phone', async () => {
    const lidId = await lidOnly();
    expect(await mergeLidPairs(ctx, pair)).toBe(0);
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, lidId));
    expect(c).toMatchObject({ phone: PHONE, lid: LID });
  });

  it("moves a deleted chat's tombstone to the phone contact, so the merge never brings the chat back", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE, name: 'Maria' });
    const now = at('2026-10-19T12:00:00.000Z');
    await ctx.db.insert(deletedChats).values({ id: randomUUID(), contactId: lidId, channelId: s.channelId, until: now, deletedAt: now });
    await mergeLidPairs(ctx, pair);
    const rows = await ctx.db.select({ contactId: deletedChats.contactId }).from(deletedChats);
    expect(rows).toEqual([{ contactId: phoneId }]);
  });

  it('leaves a contact that already has a phone alone', async () => {
    const both = await newContact(ctx, { phone: '5565988887777' });
    await ctx.db.update(contacts).set({ lid: LID }).where(eq(contacts.id, both));
    await newContact(ctx, { phone: PHONE });
    expect(await mergeLidPairs(ctx, pair)).toBe(0);
    expect(await ctx.db.$count(contacts)).toBe(2);
  });

  it('runs inside placeRecords: a live row with remoteJid @lid + remoteJidAlt merges before it is placed', async () => {
    const lidId = await lidOnly();
    const historyChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, state: 'closed', history: true });
    const phoneId = await newContact(ctx, { phone: PHONE, name: 'Maria' });

    await placeRecords(
      ctx,
      { id: s.channelId, evolutionInstance: s.instance },
      [rec({ id: 'live-lid', at: '2026-10-14T12:00:00Z', jid: LID_JID, alt: PHONE_JID, pushName: 'Maria' })],
      { names: new Map(), seen: new Set() },
    );

    expect(await ctx.db.select().from(contacts).where(eq(contacts.lid, LID))).toMatchObject([{ id: phoneId, phone: PHONE }]);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.externalId, 'live-lid'));
    expect(m!.chatId).toBe(historyChat);
    expect((await chatById(historyChat))!.contactId).toBe(phoneId);
  });
});
