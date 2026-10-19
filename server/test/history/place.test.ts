import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botRuns, chatEvents, chats, contacts, messageEdits, messages } from '../../src/db/schema.js';
import { placeRecords, realName, toHistoryEvents, writeHistoryEvents } from '../../src/history/place.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';
import { LID, LID_JID, PHONE, imageRec, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let channel: { id: string; evolutionInstance: string };

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z
  s = await seedBasics(ctx);
  channel = { id: s.channelId, evolutionInstance: s.instance };
});
afterEach(() => vi.restoreAllMocks());

const place = (records: unknown[], names = new Map<string, string>()) =>
  placeRecords(ctx, channel, records, { names, seen: new Set() });
const at = (iso: string) => new Date(iso);
const contactByPhone = async (phone: string) => (await ctx.db.select().from(contacts).where(eq(contacts.phone, phone)))[0]!;
const chatsOf = (contactId: string) => ctx.db.select().from(chats).where(eq(chats.contactId, contactId));
const chatById = async (id: string) => (await ctx.db.select().from(chats).where(eq(chats.id, id)))[0]!;
const messagesOf = (chatId: string) => ctx.db.select().from(messages).where(eq(messages.chatId, chatId));

describe('realName', () => {
  it('treats a push name made only of digits as no name', () => {
    expect(realName('556599999999')).toBeNull();
    expect(realName('+55 (65) 99999-9999')).toBeNull();
    expect(realName('   ')).toBeNull();
    expect(realName(null)).toBeNull();
    expect(realName('  Maria Souza ')).toBe('Maria Souza');
  });
});

describe('toHistoryEvents', () => {
  it('keeps 1:1 messages and drops what §5.2 leaves out', () => {
    const t = '2026-10-10T12:00:00Z';
    const events = toHistoryEvents(s.instance, [
      rec({ id: 'ok', at: t }),
      rec({ id: 'grupo', at: t, jid: '120363000000000000@g.us' }),
      rec({ id: 'status', at: t, jid: 'status@broadcast' }),
      rec({ id: 'canal', at: t, jid: '120363111111111111@newsletter' }),
      rec({ id: 'apagada', at: t, messageType: 'protocolMessage', message: { protocolMessage: { type: 0, key: { id: 'ok' } } } }),
      rec({ id: 'album', at: t, messageType: 'associatedChildMessage', message: { associatedChildMessage: { message: { imageMessage: {} } } } }),
      rec({
        id: 'edicao', at: t, messageType: 'secretEncryptedMessage',
        message: { secretEncryptedMessage: { secretEncType: 2, targetMessageKey: { id: 'ok' } } }, // the parser would yield an 'edit'
      }),
      rec({ id: 'reacao', at: t, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'ok' }, text: '👍' } } }),
      rec({ id: 'reacao-minha', at: t, fromMe: true, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'ok' }, text: '❤️' } } }),
      rec({ id: 'sem-hora', at: t, timestamp: undefined }),
      rec({ id: 'hora-zero', at: t, timestamp: 0 }),
    ]);
    expect(events.map((e) => e.externalId)).toEqual(['ok']);
    expect(events[0]).toMatchObject({ phone: PHONE, lid: null, direction: 'in', kind: 'text', sentAt: at(t) });
  });
});

describe('placeRecords', () => {
  it('with no open chat, creates one closed history chat in the default sector spanning its messages (§5.3)', async () => {
    const r = await place([
      rec({ id: 'h2', at: '2026-10-03T15:30:00Z', fromMe: true, text: 'última' }),
      rec({ id: 'h1', at: '2026-10-01T10:00:00Z', text: 'primeira' }),
    ]);

    expect(r).toMatchObject({ inserted: 2, contactsCreated: 1, oldest: at('2026-10-01T10:00:00Z') });
    const contact = await contactByPhone(PHONE);
    expect(contact.name).toBeNull(); // the history push name is only the number
    const [chat] = await chatsOf(contact.id);
    expect(chat).toMatchObject({
      history: true, state: 'closed', sectorId: s.defaultSector, ownerId: null, unread: 0, waiting: false,
      triagePending: false, private: false, createdAt: at('2026-10-01T10:00:00Z'), closedAt: at('2026-10-03T15:30:00Z'),
      lastMessageAt: at('2026-10-03T15:30:00Z'), lastMessagePreview: 'última',
    });
    expect(r.historyCounts).toEqual(new Map([[chat!.id, 2]]));
    const rows = await messagesOf(chat!.id);
    expect(rows.map((m) => [m.externalId, m.direction, m.authorId, m.status]).sort()).toEqual([
      ['h1', 'in', null, 'sent'],
      ['h2', 'out', null, 'sent'],
    ]);
    for (const m of rows) expect(m.createdAt).toEqual(m.sentAt); // §5.2: stable order with live messages

    await writeHistoryEvents(ctx, r.historyCounts);
    const events = await ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chat!.id));
    expect(events.map((e) => [e.kind, e.data])).toEqual([['history_imported', { count: 2 }]]);
  });

  it('a later import appends to the same history chat and widens its span', async () => {
    await place([rec({ id: 'b', at: '2026-10-05T10:00:00Z' })]);
    await place([rec({ id: 'a', at: '2026-09-20T10:00:00Z' }), rec({ id: 'c', at: '2026-10-08T10:00:00Z', text: 'mais nova' })]);
    const chatRows = await chatsOf((await contactByPhone(PHONE)).id);
    expect(chatRows).toHaveLength(1);
    expect(chatRows[0]).toMatchObject({
      createdAt: at('2026-09-20T10:00:00Z'), closedAt: at('2026-10-08T10:00:00Z'), lastMessagePreview: 'mais nova',
    });
  });

  it('with an open chat, messages go into it without touching unread, waiting or triage', async () => {
    const contactId = await newContact(ctx, { phone: PHONE, name: 'Maria' });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, unread: 2 });
    await ctx.db
      .update(chats)
      .set({ waiting: true, triagePending: true, lastMessageAt: at('2026-10-12T09:00:00Z'), lastMessagePreview: 'ao vivo' })
      .where(eq(chats.id, chatId));

    const r = await place([rec({ id: 'antiga', at: '2026-10-01T10:00:00Z', text: 'antiga' })]);

    expect(r.historyCounts.size).toBe(0);
    expect(await chatById(chatId)).toMatchObject({
      state: 'open', history: false, unread: 2, waiting: true, triagePending: true,
      lastMessageAt: at('2026-10-12T09:00:00Z'), lastMessagePreview: 'ao vivo',
    });
    expect(await ctx.db.$count(chats)).toBe(1);
    expect(ctx.hub.events).toEqual([{ type: 'chat', chatId }]); // one chat.updated for the batch, nothing per message

    await place([rec({ id: 'nova', at: '2026-10-13T08:00:00Z', text: 'mais nova' })]);
    expect(await chatById(chatId)).toMatchObject({ unread: 2, lastMessageAt: at('2026-10-13T08:00:00Z'), lastMessagePreview: 'mais nova' });
  });

  it('starts no bot, triage, avatar lookup or media download and writes no "created" event (§5.3)', async () => {
    const live = vi.spyOn(ctx.wa, 'downloadMedia');
    const byId = vi.spyOn(ctx.wa, 'downloadMediaById');
    await place([rec({ id: 't1', at: '2026-10-13T10:00:00Z' }), imageRec({ id: 'i1', at: '2026-10-13T10:01:00Z' })]);
    expect(await ctx.db.$count(messages)).toBe(2);
    expect(await ctx.db.$count(botRuns)).toBe(0);
    expect(await ctx.db.$count(chatEvents)).toBe(0);
    expect(ctx.wa.sent).toEqual([]);
    expect(ctx.wa.pictureLookups).toEqual([]);
    expect(live).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
    expect(ctx.hub.events.filter((e) => e.type === 'message.created')).toEqual([]);
  });

  it('never rewrites a message the webhook already stored, nor counts it again (Review Focus 1)', async () => {
    const contactId = await newContact(ctx, { phone: PHONE });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, unread: 1 });
    await ctx.db.insert(messages).values({
      chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'original', externalId: 'live1', status: 'sent',
      sentAt: at('2026-10-14T12:50:00Z'),
    });

    // Evolution rewrote the row after an edit: new content and a later timestamp, same key.id
    const r = await place([rec({ id: 'live1', at: '2026-10-14T12:50:13Z', text: 'editada depois' })]);

    expect(r.inserted).toBe(0);
    expect((await messagesOf(chatId)).map((m) => m.body)).toEqual(['original']);
    expect((await chatById(chatId)).unread).toBe(1);
  });

  it('never applies an edit, a revoke or a reaction found in the history (Review Focus 6)', async () => {
    const contactId = await newContact(ctx, { phone: PHONE });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId });
    await ctx.db.insert(messages).values({
      chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'original', externalId: 'alvo', status: 'sent',
      sentAt: at('2026-10-10T12:00:00Z'),
    });
    const t = '2026-10-10T12:05:00Z';

    const r = await place([
      rec({ id: 'apaga', at: t, messageType: 'protocolMessage', message: { protocolMessage: { type: 0, key: { id: 'alvo' } } } }),
      rec({
        id: 'edita', at: t, messageType: 'secretEncryptedMessage',
        message: { secretEncryptedMessage: { secretEncType: 2, targetMessageKey: { id: 'alvo' } } },
      }),
      rec({ id: 'reage', at: t, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'alvo' }, text: '👍' } } }),
      rec({ id: 'reage-eu', at: t, fromMe: true, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'alvo' }, text: '❤️' } } }),
      // messageType says 'conversation' but the body is a reaction: the keep-only-'message'-events filter must drop it
      rec({ id: 'reage-disfarcada', at: t, message: { reactionMessage: { key: { id: 'alvo' }, text: '👍' } } }),
      rec({ id: 'reage-eu-disfarcada', at: t, fromMe: true, message: { reactionMessage: { key: { id: 'alvo' }, text: '❤️' } } }),
    ]);

    expect(r.inserted).toBe(0);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.externalId, 'alvo'));
    expect(m).toMatchObject({ body: 'original', deletedAt: null, deletedSource: null, editedAt: null, reaction: null, officeReaction: null });
    expect(await ctx.db.$count(messages)).toBe(1);
    expect(await ctx.db.$count(messageEdits)).toBe(0);
    expect(await ctx.db.$count(chatEvents)).toBe(0);
  });

  it('a second copy of the same rows adds nothing', async () => {
    const rows = [rec({ id: 'h1', at: '2026-10-01T10:00:00Z' }), rec({ id: 'h2', at: '2026-10-02T10:00:00Z' })];
    expect((await place(rows)).inserted).toBe(2);
    expect((await place(rows)).inserted).toBe(0);
    expect(await ctx.db.$count(messages)).toBe(2);
    expect(await ctx.db.$count(chats)).toBe(1);
  });

  it('a LID-only row creates a contact with the lid and no phone; a digits-only push name is no name (§5.4)', async () => {
    await place([rec({ id: 'l1', at: '2026-10-01T10:00:00Z', jid: LID_JID })]);
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.lid, LID));
    expect(c).toMatchObject({ phone: null, lid: LID, name: null });
    expect(await chatsOf(c!.id)).toHaveLength(1);
  });

  it("names a contact from Evolution's Contact table when the push name is only digits", async () => {
    await place([rec({ id: 'l2', at: '2026-10-01T10:00:00Z', jid: LID_JID })], new Map([[`l:${LID}`, 'Maria Souza']]));
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.lid, LID));
    expect(c!.name).toBe('Maria Souza');
  });

  it('queues media up to 21 days old and marks older media expired (§5.5)', async () => {
    await place([
      imageRec({ id: 'nova', at: '2026-09-24T13:00:00Z' }), // 20 days before the fake clock
      imageRec({ id: 'velha', at: '2026-09-22T12:00:00Z' }), // 22 days
      rec({ id: 'texto', at: '2026-09-23T12:00:00Z' }),
    ]);
    const rows = await ctx.db.select().from(messages);
    expect(new Map(rows.map((m) => [m.externalId, m.mediaStatus]))).toEqual(
      new Map([['nova', 'queued'], ['velha', 'expired'], ['texto', null]]),
    );
    expect(rows.find((m) => m.externalId === 'nova')).toMatchObject({ kind: 'image', mediaMime: 'image/jpeg', mediaPath: null });
  });

  it("drops a blocked contact's history (Review Focus 3)", async () => {
    const contactId = await newContact(ctx, { phone: PHONE });
    await ctx.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, contactId));
    expect((await place([rec({ id: 'b1', at: '2026-10-01T10:00:00Z' })])).inserted).toBe(0);
    expect(await chatsOf(contactId)).toEqual([]);
  });

  it('skips a row without a valid timestamp instead of dating it today (Review Focus 2)', async () => {
    const r = await place([
      rec({ id: 'x1', at: '2026-10-01T10:00:00Z', timestamp: undefined }),
      rec({ id: 'x2', at: '2026-10-01T10:00:00Z', timestamp: 'abc' }),
    ]);
    expect(r.inserted).toBe(0);
    expect(await ctx.db.$count(chats)).toBe(0);
  });

  it('threads a quote of an earlier message of the same batch', async () => {
    await place([
      rec({ id: 'resp', at: '2026-10-01T10:05:00Z', fromMe: true, text: 'Pode sim', contextInfo: { stanzaId: 'perg' } }),
      rec({ id: 'perg', at: '2026-10-01T10:00:00Z', text: 'Posso mandar o contrato?' }),
    ]);
    const rows = await ctx.db.select().from(messages);
    const perg = rows.find((m) => m.externalId === 'perg')!;
    expect(rows.find((m) => m.externalId === 'resp')!.replyToId).toBe(perg.id);
  });
});
