import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChannelQr } from '../../src/channels/service.js';
import { channels, chats, contacts, messageEdits, messages } from '../../src/db/schema.js';
import { handleInbound, MEDIA_UNAVAILABLE, type IngestHooks } from '../../src/messages/ingest.js';
import { parseEvolutionWebhook } from '../../src/whatsapp/parse.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999999999';
let seq = 0;

function msg(over: Partial<MessageEvent> = {}): MessageEvent {
  seq += 1;
  return {
    type: 'message',
    instance: 'talk-test',
    externalId: `EXT${seq}`,
    direction: 'in',
    phone: PHONE,
    lid: null,
    pushName: 'Maria Cliente',
    kind: 'text',
    body: `mensagem ${seq}`,
    hasMedia: false,
    mediaMime: null,
    mediaName: null,
    replyToExternalId: null,
    sentAt: new Date(Date.UTC(2026, 9, 14, 12, 0, seq % 60)),
    raw: { key: { id: `EXT${seq}` } },
    ...over,
  };
}

/** Evolution v2 `messages.upsert` webhook body for a plain text message. */
function upsert(o: { id: string; remoteJid: string; fromMe: boolean; text: string; pushName?: string }) {
  return {
    event: 'messages.upsert',
    instance: 'talk-test',
    data: {
      key: { remoteJid: o.remoteJid, fromMe: o.fromMe, id: o.id },
      pushName: o.pushName ?? 'Maria Cliente',
      message: { conversation: o.text },
      messageType: 'conversation',
      messageTimestamp: 1792000000,
    },
  };
}

function stubHooks() {
  const calls: string[] = [];
  const hooks: IngestHooks = {
    startTriage: async (_ctx, chat) => {
      calls.push(`start:${chat.id}`);
    },
    handleTriageReply: async (_ctx, chat, text) => {
      calls.push(`reply:${chat.id}:${text}`);
      return true;
    },
  };
  return { calls, hooks };
}

let ctx: Ctx;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let triage: ReturnType<typeof stubHooks>;
let logged: ReturnType<typeof vi.spyOn>;

const ingest = (...events: InboundEvent[]) => handleInbound(ctx, events, triage.hooks);
const allChats = () => ctx.db.select().from(chats);
const allContacts = () => ctx.db.select().from(contacts);
const allMessages = () => ctx.db.select().from(messages);
const hubEvents = (type: string) => ctx.hub.events.filter((e) => e.type === type);
const chatPublishes = (chatId: string) => ctx.hub.events.filter((e) => e.chatId === chatId && !e.messageId);
const closeChat = (chatId: string) =>
  ctx.db.update(chats).set({ state: 'closed', closedAt: new Date(), waiting: false, unread: 0 }).where(eq(chats.id, chatId));

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ctx.config.mediaDir = await mkdtemp(join(tmpdir(), 'talk-media-'));
  triage = stubHooks();
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logged.mockRestore();
});

describe('handleInbound: messages', () => {
  it('a 12-digit JID reaches the contact imported with 13 digits (Review Focus 1)', async () => {
    const [imported] = await ctx.db
      .insert(contacts)
      .values({ id: randomUUID(), phone: PHONE, name: 'Importado do Umbler' })
      .returning();

    await ingest(...parseEvolutionWebhook(upsert({ id: 'RF1A', remoteJid: '556599999999@s.whatsapp.net', fromMe: false, text: 'bom dia' })));

    const people = await allContacts();
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe('Importado do Umbler');
    const [chat] = await allChats();
    expect(chat.contactId).toBe(imported.id);
    const [m] = await allMessages();
    expect(m).toMatchObject({ chatId: chat.id, direction: 'in', body: 'bom dia', externalId: 'RF1A', authorId: null });
  });

  it('a 12-digit landline does not gain a 9 (Review Focus 1)', async () => {
    await ingest(...parseEvolutionWebhook(upsert({ id: 'RF1B', remoteJid: '556532221111@s.whatsapp.net', fromMe: false, text: 'oi' })));
    const [c] = await allContacts();
    expect(c.phone).toBe('556532221111');
    expect(c.name).toBe('Maria Cliente');
  });

  it('a first inbound message opens a waiting chat in the default sector and starts triage', async () => {
    await ingest(msg({ body: 'Olá' }));
    const [chat] = await allChats();
    expect(chat).toMatchObject({
      sectorId: seed.defaultSector,
      channelId: seed.channelId,
      ownerId: null,
      state: 'open',
      waiting: true,
      unread: 1,
      lastMessagePreview: 'Olá',
    });
    const [m] = await allMessages();
    expect(m.status).toBe('sent');
    expect(hubEvents('message.created')).toEqual([expect.objectContaining({ chatId: chat.id, messageId: m.id })]);
    expect(chatPublishes(chat.id).length).toBeGreaterThanOrEqual(1);
    expect(triage.calls).toEqual([`start:${chat.id}`]);
  });

  it('the same upsert delivered twice is stored once (Review Focus 2)', async () => {
    const ev = msg();
    await ingest(ev);
    await ingest(ev, ev);
    expect(await allMessages()).toHaveLength(1);
    const [chat] = await allChats();
    expect(chat.unread).toBe(1);
    expect(hubEvents('message.created')).toHaveLength(1);
    expect(triage.calls).toHaveLength(1);
  });

  it('a status update for an unknown message is a no-op and the message still arrives later (Review Focus 2)', async () => {
    await expect(ingest({ type: 'status', instance: 'talk-test', externalId: 'LATE1', status: 'delivered' })).resolves.toBeUndefined();
    expect(await allMessages()).toHaveLength(0);
    expect(await allChats()).toHaveLength(0);

    await ingest(msg({ externalId: 'LATE1' }));
    expect(await allMessages()).toHaveLength(1);
  });

  it('a message typed on the office phone is out, clears waiting, triage and unread (Review Focus 3)', async () => {
    await ingest(msg({ body: 'preciso de ajuda' }));
    const [open] = await allChats();
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, open.id));
    triage.calls.length = 0;

    await ingest(
      ...parseEvolutionWebhook(
        upsert({ id: 'RF3OUT', remoteJid: '556599999999@s.whatsapp.net', fromMe: true, text: 'Já te respondo', pushName: 'Escritório JVO' }),
      ),
    );

    const [chat] = await allChats();
    expect(chat).toMatchObject({ waiting: false, triagePending: false, unread: 0, lastMessagePreview: 'Já te respondo' });
    const out = (await allMessages()).find((m) => m.externalId === 'RF3OUT');
    expect(out).toMatchObject({ direction: 'out', authorId: null, chatId: chat.id });
    expect(triage.calls).toEqual([]);
    expect((await allContacts())[0].name).toBe('Maria Cliente');
  });

  it('a phone message with no open chat opens one without waiting, unread or triage (Review Focus 3)', async () => {
    await ingest(msg({ direction: 'out', pushName: 'Escritório JVO', body: 'Olá, aqui é do escritório' }));
    const [chat] = await allChats();
    expect(chat).toMatchObject({ state: 'open', waiting: false, triagePending: false, unread: 0 });
    expect(triage.calls).toEqual([]);
    const [contact] = await allContacts();
    expect(contact.phone).toBe(PHONE);
    expect(contact.name).toBeNull();
  });

  it('routes the next inbound message to triage while triage is pending', async () => {
    await ingest(msg({ body: 'oi' }));
    const [chat] = await allChats();
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, chat.id));
    await ingest(msg({ body: '2' }));
    expect(triage.calls).toEqual([`start:${chat.id}`, `reply:${chat.id}:2`]);
  });

  it('a new inbound message after the chat was closed opens a new chat', async () => {
    await ingest(msg());
    const [first] = await allChats();
    await closeChat(first.id);

    await ingest(msg({ body: 'voltei' }));

    const list = await allChats();
    expect(list).toHaveLength(2);
    const second = list.find((c) => c.id !== first.id)!;
    expect(second).toMatchObject({ state: 'open', waiting: true, unread: 1, lastMessagePreview: 'voltei' });
    expect(list.find((c) => c.id === first.id)).toMatchObject({ state: 'closed', unread: 0 });
    expect(triage.calls).toEqual([`start:${first.id}`, `start:${second.id}`]);
  });

  it('drops messages from a blocked contact', async () => {
    await ctx.db.insert(contacts).values({ id: randomUUID(), phone: PHONE, name: 'Bloqueado', blocked: true });
    await ingest(msg());
    expect(await allMessages()).toHaveLength(0);
    expect(await allChats()).toHaveLength(0);
    expect(hubEvents('message.created')).toHaveLength(0);
    expect(triage.calls).toEqual([]);
  });

  it('a lid-only message attaches to the contact found by lid', async () => {
    const [known] = await ctx.db
      .insert(contacts)
      .values({ id: randomUUID(), phone: PHONE, lid: '200001112223334', name: 'Cliente LID' })
      .returning();
    await ingest(msg({ phone: null, lid: '200001112223334' }));
    expect(await allContacts()).toHaveLength(1);
    const [chat] = await allChats();
    expect(chat.contactId).toBe(known.id);
  });

  it('fills the missing phone of a contact found by lid (normalizing it)', async () => {
    const [known] = await ctx.db.insert(contacts).values({ id: randomUUID(), lid: 'LID-77', name: null }).returning();
    await ingest(msg({ phone: '556599999999', lid: 'LID-77', pushName: 'Joana' }));
    const people = await allContacts();
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: known.id, phone: PHONE, lid: 'LID-77', name: 'Joana' });
  });

  it('does not steal a lid that already belongs to another contact', async () => {
    const [byPhone] = await ctx.db.insert(contacts).values({ id: randomUUID(), phone: PHONE, name: 'Pelo telefone' }).returning();
    await ctx.db.insert(contacts).values({ id: randomUUID(), lid: 'LID-88', name: 'Pelo lid' });
    await ingest(msg({ phone: PHONE, lid: 'LID-88' }));
    const [chat] = await allChats();
    expect(chat.contactId).toBe(byPhone.id);
    const [after] = await ctx.db.select().from(contacts).where(eq(contacts.id, byPhone.id));
    expect(after.lid).toBeNull();
  });

  it('duplicate first messages (sequential) from a new contact create one contact and one chat', async () => {
    // PGlite serializes transactions, so these two run one after the other; this checks the lookup-then-insert
    // path, not a real race. Real race safety relies on ON CONFLICT DO NOTHING + re-read (partial unique indexes).
    await Promise.all([ingest(msg()), ingest(msg())]);
    expect(await allContacts()).toHaveLength(1);
    const list = await allChats();
    expect(list).toHaveLength(1);
    expect(list[0].unread).toBe(2);
    expect(await allMessages()).toHaveLength(2);
    expect(triage.calls).toHaveLength(1);
  });

  it('resolves the quoted message, and leaves reply empty when the quote is unknown', async () => {
    const a = msg();
    await ingest(a);
    const b = msg({ replyToExternalId: a.externalId });
    const c = msg({ replyToExternalId: 'NAO-EXISTE' });
    await ingest(b, c);
    const rows = await allMessages();
    const ma = rows.find((m) => m.externalId === a.externalId)!;
    expect(rows.find((m) => m.externalId === b.externalId)!.replyToId).toBe(ma.id);
    expect(rows.find((m) => m.externalId === c.externalId)!.replyToId).toBeNull();
  });

  it('a late message does not move the chat back in time', async () => {
    await ingest(msg({ body: 'nova', sentAt: new Date('2026-10-14T15:00:00Z') }));
    await ingest(msg({ body: 'atrasada', sentAt: new Date('2026-10-14T09:00:00Z') }));
    const [chat] = await allChats();
    expect(chat.lastMessageAt?.toISOString()).toBe('2026-10-14T15:00:00.000Z');
    expect(chat.lastMessagePreview).toBe('nova');
    expect(chat.unread).toBe(2);
  });

  it('downloads media after commit and stores it under mediaDir', async () => {
    await ingest(msg({ kind: 'image', body: null, hasMedia: true, mediaMime: 'image/png' }));
    const [m] = await allMessages();
    expect(m.mediaPath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(m.mediaMime).toBe('image/png');
    expect(m.error).toBeNull();
    const bytes = await readFile(join(ctx.config.mediaDir, m.mediaPath!));
    expect(bytes.length).toBe(m.mediaSize);
    const [chat] = await allChats();
    expect(chat.lastMessagePreview).toBe('📷 Imagem');
    expect(hubEvents('message.updated')).toEqual([expect.objectContaining({ messageId: m.id })]);
  });

  it('keeps the message and marks the media unavailable when the download fails', async () => {
    ctx.wa.downloadMedia = async () => {
      throw new Error('Evolution fora do ar');
    };
    await ingest(msg({ kind: 'document', body: null, hasMedia: true, mediaMime: 'application/pdf', mediaName: 'contrato.pdf' }));
    const [m] = await allMessages();
    expect(m).toMatchObject({ kind: 'document', mediaPath: null, mediaName: 'contrato.pdf', error: MEDIA_UNAVAILABLE });
    expect(hubEvents('message.updated')).toEqual([expect.objectContaining({ messageId: m.id })]);
    // the cause is reported (name and message only, never the body or base64), so a systemic failure is visible
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('media download failed', { messageId: m.id, err: 'Error: Evolution fora do ar' });
  });

  it('also reports the cause when the file cannot be saved, and still keeps the message', async () => {
    const blocker = join(ctx.config.mediaDir, 'ocupado');
    await writeFile(blocker, 'x');
    ctx.config.mediaDir = blocker; // mkdir under a regular file fails (ENOTDIR)
    await ingest(msg({ kind: 'image', body: 'legenda secreta', hasMedia: true, mediaMime: 'image/png' }));
    const [m] = await allMessages();
    expect(m).toMatchObject({ mediaPath: null, error: MEDIA_UNAVAILABLE });
    expect(logged).toHaveBeenCalledTimes(1);
    const [label, detail] = logged.mock.calls[0] as [string, { messageId: string; err: string }];
    expect(label).toBe('media download failed');
    expect(detail.messageId).toBe(m.id);
    expect(detail.err).toMatch(/ENOTDIR|EEXIST|ENOENT/);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('legenda secreta');
  });

  it('skips events for an unknown instance', async () => {
    await ingest(msg({ instance: 'talk-outro' }));
    expect(await allMessages()).toHaveLength(0);
    expect(await allChats()).toHaveLength(0);
  });
});

describe('handleInbound: reactions', () => {
  it('a reaction on a closed chat only sets the reaction (no new chat, no unread, no waiting)', async () => {
    const target = msg();
    await ingest(target);
    const [chat] = await allChats();
    await closeChat(chat.id);

    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: target.externalId, emoji: '👍' });

    const list = await allChats();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: 'closed', unread: 0, waiting: false });
    const [m] = await allMessages();
    expect(m.reaction).toBe('👍');
    expect(hubEvents('message.updated')).toEqual([expect.objectContaining({ chatId: chat.id, messageId: m.id })]);

    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: target.externalId, emoji: null });
    expect((await allMessages())[0].reaction).toBeNull();
  });

  it('ignores a reaction whose target is unknown', async () => {
    await expect(
      ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: 'NAO-EXISTE', emoji: '👍' }),
    ).resolves.toBeUndefined();
    expect(await allChats()).toHaveLength(0);
    expect(hubEvents('message.updated')).toHaveLength(0);
  });
});

describe('handleInbound: status', () => {
  it('only moves status forward', async () => {
    const ev = msg({ direction: 'out', body: 'enviado pelo celular' });
    await ingest(ev);
    const st = (status: 'sent' | 'delivered' | 'read' | 'failed') =>
      ingest({ type: 'status', instance: 'talk-test', externalId: ev.externalId, status });

    await st('read');
    await st('delivered');
    await st('failed');

    const [m] = await allMessages();
    expect(m.status).toBe('read');
    expect(hubEvents('message.updated')).toHaveLength(1);
  });

  it('marks failed only from pending or sent', async () => {
    const ev = msg({ direction: 'out' });
    await ingest(ev);
    await ingest({ type: 'status', instance: 'talk-test', externalId: ev.externalId, status: 'failed' });
    const [m] = await allMessages();
    expect(m.status).toBe('failed');
  });
});

describe('handleInbound: channel events', () => {
  it('updates channel status and phone, publishing only on change', async () => {
    await ctx.db.update(channels).set({ status: 'disconnected', phone: null }).where(eq(channels.id, seed.channelId));

    await ingest({ type: 'connection', instance: 'talk-test', status: 'connected', phone: '5565988887777' });
    await ingest({ type: 'connection', instance: 'talk-test', status: 'connected', phone: '5565988887777' });
    await ingest({ type: 'connection', instance: 'talk-desconhecida', status: 'connected', phone: null });

    const [ch] = await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId));
    expect(ch).toMatchObject({ status: 'connected', phone: '5565988887777' });
    expect(ctx.hub.events.filter((e) => e.channelId === seed.channelId)).toHaveLength(1);
  });

  it('a connection event without phone keeps the stored number', async () => {
    await ctx.db.update(channels).set({ status: 'connected', phone: '5565988887777' }).where(eq(channels.id, seed.channelId));
    await ingest({ type: 'connection', instance: 'talk-test', status: 'disconnected', phone: null });
    const [ch] = await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId));
    expect(ch).toMatchObject({ status: 'disconnected', phone: '5565988887777' });
  });

  it('keeps the latest QR of a known instance in memory and clears it once connected (§5.6)', async () => {
    await ctx.db.update(channels).set({ status: 'connecting' }).where(eq(channels.id, seed.channelId));
    await ingest({ type: 'qrcode', instance: 'talk-test', qrBase64: 'data:image/png;base64,AAAA' });
    await ingest({ type: 'qrcode', instance: 'talk-test', qrBase64: 'data:image/png;base64,BBBB' });
    await ingest({ type: 'qrcode', instance: 'talk-desconhecida', qrBase64: 'data:image/png;base64,CCCC' });
    expect(getChannelQr(ctx, 'talk-test')).toBe('data:image/png;base64,BBBB');
    expect(getChannelQr(ctx, 'talk-desconhecida')).toBeNull();
    expect(ctx.hub.events.filter((e) => e.channelId)).toHaveLength(0);

    await ingest({ type: 'connection', instance: 'talk-test', status: 'connected', phone: '5565988887777' });
    expect(getChannelQr(ctx, 'talk-test')).toBeNull();
  });
});

describe('handleInbound: office reactions, deletes and edits', () => {
  const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../fixtures/evolution/${name}.json`, import.meta.url), 'utf8'));
  const edits = () => ctx.db.select().from(messageEdits);
  const kinds = async (chatId: string, kind: string) => (await eventsOf(ctx, chatId)).filter((e) => e.kind === kind);
  async function stored(over: Partial<MessageEvent> = {}) {
    const ev = msg(over);
    await ingest(ev);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.externalId, ev.externalId));
    return row!;
  }

  it('puts a reaction made on the office phone in the office slot and keeps the contact one', async () => {
    const m = await stored();
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: '👍', fromMe: false });
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: '❤️', fromMe: true });
    expect((await allMessages())[0]).toMatchObject({ reaction: '👍', officeReaction: '❤️' });
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: null, fromMe: true });
    expect((await allMessages())[0]).toMatchObject({ reaction: '👍', officeReaction: null });
  });

  it('a revoke by the contact keeps the text, marks it deleted and logs the event once', async () => {
    const m = await stored({ body: 'mensagem que o contato apagou' });
    const revoke = { type: 'revoke' as const, instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false };
    await ingest(revoke);
    await ingest(revoke); // Evolution retry

    const [after] = await allMessages();
    expect(after).toMatchObject({ body: 'mensagem que o contato apagou', deletedSource: 'contact', deletedBy: null });
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(await kinds(m.chatId, 'message_deleted')).toMatchObject([{ authorId: null, data: { messageId: m.id, source: 'contact' } }]);
    expect(hubEvents('message.updated').at(-1)).toMatchObject({ chatId: m.chatId, messageId: m.id });
    expect(chatPublishes(m.chatId).length).toBeGreaterThan(1); // the ingest publish, then the delete's
  });

  it('a revoke from the office phone is source phone', async () => {
    const m = await stored({ direction: 'out', body: 'enviada pelo celular' });
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: true });
    expect((await allMessages())[0]).toMatchObject({ deletedSource: 'phone' });
    expect(await kinds(m.chatId, 'message_deleted')).toMatchObject([{ data: { source: 'phone' } }]);
  });

  it('a contact edit replaces the body and keeps the previous text in the history', async () => {
    const m = await stored({ body: 'Olá, preciso de ajuda' });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false, text: 'Olá, preciso de ajuda urgente' });

    const [after] = await allMessages();
    expect(after.body).toBe('Olá, preciso de ajuda urgente');
    expect(after.editedAt).toBeInstanceOf(Date);
    expect(await edits()).toMatchObject([
      { messageId: m.id, previousBody: 'Olá, preciso de ajuda', source: 'contact', editedBy: null, newTextUnavailable: false },
    ]);
    expect((await edits())[0]!.editedAt.getTime()).toBe(after.editedAt!.getTime());
    expect(await kinds(m.chatId, 'message_edited')).toMatchObject([{ data: { messageId: m.id, source: 'contact' } }]);
  });

  it('matches an edit by WhatsApp id even when it carries an @lid remoteJid', async () => {
    await ingest(...parseEvolutionWebhook(fixture('text-in')));
    await ingest(...parseEvolutionWebhook(fixture('edit-update-in')));
    expect((await allMessages())[0]!.body).toBe('Olá, preciso de ajuda urgente');
  });

  it('the encrypted edit format marks the target, keeps its text and adds no bubble', async () => {
    await ingest(...parseEvolutionWebhook(fixture('text-in')));
    await ingest(...parseEvolutionWebhook(fixture('secret-edit-in')));

    const all = await allMessages();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ externalId: 'MSG-TEXT-IN', kind: 'text', body: 'Olá, preciso de ajuda' });
    expect(all[0]!.editedAt).toBeInstanceOf(Date);
    expect(await edits()).toMatchObject([{ previousBody: 'Olá, preciso de ajuda', source: 'contact', newTextUnavailable: true }]);
  });

  it('ignores the echoes of the office actions (Review Focus 1)', async () => {
    const m = await stored({ direction: 'out', body: 'apagada pelo atendente' });
    await ctx.db
      .update(messages)
      .set({ deletedAt: new Date(), deletedBy: seed.agentA.id, deletedSource: 'office', officeReaction: '👍' })
      .where(eq(messages.id, m.id));
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: true });
    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: m.externalId!, emoji: '👍', fromMe: true });
    const [after] = await ctx.db.select().from(messages).where(eq(messages.id, m.id));
    expect(after).toMatchObject({ deletedSource: 'office', deletedBy: seed.agentA.id, officeReaction: '👍' });
    expect(await kinds(m.chatId, 'message_deleted')).toEqual([]);

    const n = await stored({ direction: 'out', body: 'já editado pelo sistema' });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: n.externalId!, fromMe: true, text: 'já editado pelo sistema' });
    expect(await edits()).toEqual([]);
    expect(await kinds(n.chatId, 'message_edited')).toEqual([]);
  });

  it('ignores unknown targets and never edits a deleted message', async () => {
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: 'NAO-EXISTE', fromMe: false });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: 'NAO-EXISTE', fromMe: false, text: 'x' });
    expect(hubEvents('message.updated')).toHaveLength(0);

    const m = await stored({ body: 'apagada' });
    await ingest({ type: 'revoke', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false });
    await ingest({ type: 'edit', instance: 'talk-test', targetExternalId: m.externalId!, fromMe: false, text: 'editada depois' });
    expect((await allMessages())[0]!.body).toBe('apagada');
    expect(await edits()).toEqual([]);
  });

  it('stores the content hash of a downloaded file (dedupes recent stickers)', async () => {
    await ingest(msg({ kind: 'sticker', body: null, hasMedia: true, mediaMime: 'image/webp' }));
    expect((await allMessages())[0]!.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
