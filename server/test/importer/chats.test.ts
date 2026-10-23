import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyUmblerCounts } from '@talk/shared';
import {
  botRuns, chatEvents, chatTags, chats, contacts, deletedChats, messages, sectors, tags, umblerMap, users,
} from '../../src/db/schema.js';
import { importChat } from '../../src/importer/chats.js';
import { UmblerError, importCatalog, type ImportRun } from '../../src/importer/umbler.js';
import { PDF, umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { importWorld, runFor, type World } from './world.js';

let w: World;
let run: ImportRun;
beforeEach(async () => {
  w = await importWorld();
  run = await runFor(w);
  await importCatalog(run);
});
afterEach(async () => {
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

type Obj = Record<string, unknown>;
/** Puts a chat and its messages in the fake Umbler. */
function given(chat: Obj, list: Obj[]): Obj {
  w.fake.world.chats.push(chat);
  w.fake.world.messages[chat.id as string] = list;
  return chat;
}
const localOf = async (umblerId: string) =>
  (await w.ctx.db.select().from(umblerMap).where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, umblerId))))[0];
const chatOf = async (umblerId: string) => {
  const m = await localOf(umblerId);
  return m ? (await w.ctx.db.select().from(chats).where(eq(chats.id, m.localId)))[0] : undefined;
};
const rowsOf = (chatId: string) => w.ctx.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.sentAt));
const eventsOf = (chatId: string) => w.ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chatId)).orderBy(asc(chatEvents.createdAt));
const userId = async (email: string) => (await w.ctx.db.select().from(users).where(eq(users.email, email)))[0]!.id;
const sectorId = async (name: string) => (await w.ctx.db.select().from(sectors).where(eq(sectors.name, name)))[0]!.id;
const tagId = async (name: string) => (await w.ctx.db.select().from(tags).where(eq(tags.name, name)))[0]!.id;
const relativeCalls = () => w.fake.calls(/relative-messages/);
const file = (name: string, over: Obj = {}) => ({
  url: w.fake.fileUrl(name), contentType: 'application/pdf', originalName: name, originalSizeBytes: PDF.length, caption: null, failDownload: false,
  ...over,
});

describe('a finished chat (spec 2026-10-21 importar-umbler §7.6, §7.7)', () => {
  it('lands in Finalizados with its dates, sector, owner (inactive too), privacy, tags, messages and the closed event', async () => {
    const chat = given(
      umblerChat({
        open: false, createdAtUTC: '2026-08-01T10:00:00Z', closedAtUTC: '2026-08-01T11:00:00Z', sector: { id: 'SEC3' },
        organizationMember: { id: 'M_CARLA' }, private: true, tags: [{ id: 'TAG1' }], closedBy: { id: 'M_ANA' },
      }),
      [
        umblerMessage('U1', '2026-08-01T10:00:00Z', { content: 'Bom dia, preciso de ajuda', messageState: 'Read' }),
        umblerMessage('U2', '2026-08-01T10:01:00Z', {
          source: 'Member', sentByOrganizationMember: { id: 'M_CARLA' }, prefix: 'Trabalhista - Carla', content: 'Claro!',
          inReplyTo: { id: 'U1' }, messageState: 'Received', reactions: [{ emoji: '👍', source: 'Contact', eventAtUTC: '2026-08-01T10:02:00Z' }],
        }),
        umblerMessage('U3', '2026-08-01T10:03:00Z', { isPrivate: true, source: 'Member', sentByOrganizationMember: { id: 'M_ANA' }, content: 'Cliente antigo' }),
        umblerMessage('U4', '2026-08-01T10:04:00Z', { content: 'apaguei', messageState: 'Deleted' }),
        umblerMessage('U5', '2026-08-01T10:05:00Z', { source: 'Bot', content: 'Atendimento encerrado.' }),
      ],
    );

    expect(await importChat(run, chat as never, 'closed')).toBe(true);

    const local = (await chatOf(chat.id as string))!;
    const carla = await userId('carla@antigo.test');
    expect(local).toMatchObject({
      state: 'closed', history: false, sectorId: await sectorId('Trabalhista'), ownerId: carla, private: true, unread: 0, waiting: false,
      triagePending: false, createdAt: new Date('2026-08-01T10:00:00Z'), closedAt: new Date('2026-08-01T11:00:00Z'),
      lastMessageAt: new Date('2026-08-01T10:05:00Z'), lastMessagePreview: 'Atendimento encerrado.',
    });
    expect((await w.ctx.db.select().from(chatTags).where(eq(chatTags.chatId, local.id))).map((t) => t.tagId)).toEqual([await tagId('Cliente')]);
    const rows = await rowsOf(local.id);
    expect(rows.map(({ direction, kind, body, authorId, status, externalId }) => ({ direction, kind, body, authorId, status, externalId }))).toEqual([
      { direction: 'in', kind: 'text', body: 'Bom dia, preciso de ajuda', authorId: null, status: 'read', externalId: null },
      { direction: 'out', kind: 'text', body: '*Trabalhista - Carla:*\nClaro!', authorId: carla, status: 'delivered', externalId: null },
      { direction: 'out', kind: 'note', body: 'Cliente antigo', authorId: w.s.agentA.id, status: 'sent', externalId: null },
      { direction: 'in', kind: 'text', body: 'apaguei', authorId: null, status: 'sent', externalId: null },
      { direction: 'out', kind: 'text', body: 'Atendimento encerrado.', authorId: null, status: 'read', externalId: null },
    ]);
    expect(rows[1]).toMatchObject({ replyToId: rows[0]!.id, reaction: '👍', sentAt: new Date('2026-08-01T10:01:00Z') });
    expect(rows[3]).toMatchObject({ deletedAt: new Date('2026-08-01T10:04:00Z'), deletedSource: 'contact' });
    expect((await eventsOf(local.id)).map(({ kind, data, authorId, createdAt }) => ({ kind, data, authorId, createdAt }))).toEqual([
      { kind: 'umbler_imported', data: { count: 5 }, authorId: null, createdAt: new Date('2026-08-01T10:00:00Z') },
      { kind: 'closed', data: {}, authorId: w.s.agentA.id, createdAt: new Date('2026-08-01T11:00:00Z') },
    ]);
    expect((await localOf(chat.id as string))!.doneAt).not.toBeNull();
    expect(run.progress.messages).toMatchObject({ total: 5, notes: 1, bot: 1, unknownAuthor: 0 });
    expect(run.progress.chats.closed).toBe(1);
    expect(w.ctx.hub.events.filter((e) => e.type === 'chat')).toEqual([]); // closed chats never publish
    expect(await w.ctx.db.$count(contacts, eq(contacts.phone, '5565999998888'))).toBe(1); // created from chat.contact
  });
});

describe('an open chat (§7.6)', () => {
  it('keeps sector, active owner, waiting and unread; waiting_since falls back to the last contact message; publishes once', async () => {
    const chat = given(umblerChat({ waiting: true, waitingSinceUTC: null, totalUnread: 2 }), [
      umblerMessage('U1', '2026-10-20T10:00:00Z'),
      umblerMessage('U2', '2026-10-20T10:01:00Z', { source: 'Member', sentByOrganizationMember: { id: 'M_ANA' } }),
      umblerMessage('U3', '2026-10-20T10:02:00Z'),
    ]);
    const inactive = given(
      umblerChat({
        organizationMember: { id: 'M_CARLA' }, waiting: true, waitingSinceUTC: '2026-10-20T09:00:00Z',
        contact: { id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: null },
      }),
      [umblerMessage('U9', '2026-10-20T09:00:00Z')],
    );

    await importChat(run, chat as never, 'open');
    await importChat(run, inactive as never, 'open');

    const local = (await chatOf(chat.id as string))!;
    expect(local).toMatchObject({
      state: 'open', sectorId: w.s.sectorA, ownerId: w.s.agentA.id, waiting: true, waitingSince: new Date('2026-10-20T10:02:00Z'),
      unread: 2, private: false, triagePending: false, history: false, closedAt: null,
    });
    expect(await chatOf(inactive.id as string)).toMatchObject({ ownerId: null, waitingSince: new Date('2026-10-20T09:00:00Z') }); // to the queue
    expect(w.ctx.hub.events.filter((e) => e.type === 'chat' && e.chatId === local.id)).toHaveLength(1);
    expect(run.progress.chats).toMatchObject({ openCreated: 2, openMerged: 0 });
    expect(w.ctx.wa.sent).toEqual([]); // no WhatsApp send, no triage, no bot
    expect(await w.ctx.db.$count(botRuns)).toBe(0);
  });

  it("joins the contact's open chat here (decision §7.6): it stays the current one, unread adds up, tags unite", async () => {
    const [maria] = await w.ctx.db.insert(contacts).values({ phone: '5565999998888', name: 'Maria' }).returning();
    const [ours] = await w.ctx.db
      .insert(chats)
      .values({ contactId: maria!.id, channelId: w.s.channelId, sectorId: w.s.sectorB, ownerId: w.s.agentB.id, unread: 1, lastMessageAt: new Date('2026-10-21T08:00:00Z') })
      .returning();
    await w.ctx.db.insert(chatTags).values({ chatId: ours!.id, tagId: await tagId('Prospecção') });
    const chat = given(umblerChat({ tags: [{ id: 'TAG1' }], totalUnread: 2, waiting: true, private: true }), [
      umblerMessage('U1', '2026-10-20T10:00:00Z'),
      umblerMessage('U2', '2026-10-20T10:01:00Z'),
    ]);

    await importChat(run, chat as never, 'open');

    const local = (await chatOf(chat.id as string))!;
    expect(local).toMatchObject({ id: ours!.id, sectorId: w.s.sectorB, ownerId: w.s.agentB.id, waiting: false, private: false, unread: 3 });
    expect(local.lastMessageAt).toEqual(new Date('2026-10-20T10:01:00Z')); // the newest message it has
    expect((await w.ctx.db.select().from(chatTags).where(eq(chatTags.chatId, ours!.id))).map((t) => t.tagId).sort()).toEqual(
      [await tagId('Cliente'), await tagId('Prospecção')].sort(),
    );
    expect((await eventsOf(ours!.id)).map((e) => [e.kind, e.data])).toEqual([['umbler_imported', { count: 2, merged: true }]]);
    expect(run.progress.chats).toMatchObject({ openCreated: 0, openMerged: 1 });
  });
});

describe('files (§7.8)', () => {
  it('downloads up to 4 at a time without Authorization; gone, missing or no link → unavailable; a temporary failure is retried later', async () => {
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf']) w.fake.world.files[name] = { body: PDF, mime: 'application/pdf', delayMs: 30 };
    w.fake.world.files['proibido.pdf'] = { body: PDF, mime: 'application/pdf', status: 403 };
    w.fake.faults.push({ path: /^\/s3\/e\.pdf$/, status: 500, times: 4 });
    const doc = (id: string, minute: number, f: Obj) =>
      umblerMessage(id, `2026-08-01T10:0${minute}:00Z`, { messageType: 'File', content: null, file: f });
    const chat = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z' }), [
      doc('U1', 1, file('a.pdf')), doc('U2', 2, file('b.pdf')), doc('U3', 3, file('c.pdf')), doc('U4', 4, file('d.pdf')),
      doc('U5', 5, file('proibido.pdf')), doc('U6', 6, file('sumiu.pdf')), doc('U7', 7, file('x.pdf', { failDownload: true })),
      doc('U8', 8, file('e.pdf')),
    ]);

    await importChat(run, chat as never, 'closed');

    const local = (await chatOf(chat.id as string))!;
    const rows = await rowsOf(local.id);
    expect(rows.map((r) => [r.kind, r.mediaName, r.mediaStatus, r.mediaPath !== null])).toEqual([
      ['document', 'a.pdf', null, true], ['document', 'b.pdf', null, true], ['document', 'c.pdf', null, true], ['document', 'd.pdf', null, true],
      ['document', 'proibido.pdf', 'expired', false], ['document', 'sumiu.pdf', 'expired', false], ['document', 'x.pdf', 'expired', false],
      ['document', 'e.pdf', 'expired', false],
    ]);
    expect(await readFile(join(w.ctx.config.mediaDir, rows[0]!.mediaPath!))).toEqual(PDF);
    expect(rows[0]).toMatchObject({ mediaMime: 'application/pdf', mediaSize: PDF.length });
    expect(rows[0]!.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.fake.stats.maxConcurrentFiles).toBeLessThanOrEqual(4);
    expect(run.progress.files).toEqual({ saved: 4, bytes: 4 * PDF.length, expired: 4 });
    expect((await localOf(chat.id as string))!.doneAt).toBeNull(); // e.pdf failed for now: not done

    run.progress = { ...emptyUmblerCounts(), done: 0, total: 0, chatsRead: 0, maps: run.progress.maps }; // a new run: new counters
    await importChat(run, chat as never, 'closed'); // reads the chat again and retries the unavailable ones
    expect((await rowsOf(local.id)).map((r) => r.mediaStatus)).toEqual([null, null, null, null, 'expired', 'expired', 'expired', null]);
    expect(run.progress.files).toEqual({ saved: 1, bytes: PDF.length, expired: 0 }); // never "-1 indisponíveis"
    expect((await localOf(chat.id as string))!.doneAt).not.toBeNull();
    expect(await w.ctx.db.$count(messages)).toBe(8);
  });

  it('stops with disk_full below 2 GB, before the file', async () => {
    w.free.bytes = 1024 ** 3;
    const chat = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z' }), [
      umblerMessage('U1', '2026-08-01T10:00:00Z', { messageType: 'File', file: file('a.pdf') }),
    ]);
    const err = await importChat(run, chat as never, 'closed').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmblerError);
    expect(err).toMatchObject({ code: 'disk_full' });
    expect(w.fake.calls(/^\/s3\/a\.pdf$/)).toEqual([]); // the catalog in beforeEach already fetched procuracao.pdf
    expect(await chatOf(chat.id as string)).toBeUndefined();
  });
});

describe('what is skipped (§7.3, §7.6)', () => {
  it('channel "Não importar", no message at all, no phone nor LID, the tombstone, and a chat deleted here', async () => {
    const web = given(umblerChat({ channel: { _t: 'ChatWebsiteWidgetChannelReferenceModel', id: 'CH_WEB', name: 'Site' } }), [
      umblerMessage('W1', '2026-08-01T10:00:00Z'),
    ]);
    const empty = given(umblerChat(), []);
    const nobody = given(umblerChat({ contact: { id: 'C4', name: 'Sem Número', phoneNumber: null, lid: null } }), [umblerMessage('N1', '2026-08-01T10:00:00Z')]);
    expect(await importChat(run, web as never, 'open')).toBe(false);
    expect(await importChat(run, empty as never, 'open')).toBe(true);
    expect(await importChat(run, nobody as never, 'open')).toBe(false);
    expect(relativeCalls().map((r) => r.path)).toEqual([`/api/v1/chats/${empty.id}/relative-messages/`]);
    expect(await chatOf(empty.id as string)).toBeUndefined();

    // a chat an admin deleted here: messages up to the tombstone stay out of a new chat
    const [maria] = await w.ctx.db.select().from(contacts).where(eq(contacts.phone, '5565999998888'));
    await w.ctx.db.insert(deletedChats).values({ contactId: maria!.id, channelId: w.s.channelId, until: new Date('2026-08-01T10:30:00Z'), deletedAt: new Date() });
    const after = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T12:00:00Z' }), [
      umblerMessage('T1', '2026-08-01T10:00:00Z'),
      umblerMessage('T2', '2026-08-01T11:00:00Z'),
    ]);
    await importChat(run, after as never, 'closed');
    const local = (await chatOf(after.id as string))!;
    expect((await rowsOf(local.id)).map((r) => r.body)).toEqual(['texto T2']);

    await w.ctx.db.delete(chats).where(eq(chats.id, local.id)); // deleted here: never comes back
    expect(await importChat(run, after as never, 'closed')).toBe(false);
    expect(await w.ctx.db.$count(chats, eq(chats.id, local.id))).toBe(0);
    expect(run.progress.chats).toMatchObject({ skippedChannel: 1, skippedEmpty: 1, skippedNoAddress: 1, skippedDeleted: 1, closed: 1 });
  });
});

describe('the contact (§7.4)', () => {
  it('a contact created from chat.contact joins the LID-only contact here (mergeLidPairs), as the contacts phase does', async () => {
    const [phone] = await w.ctx.db.insert(contacts).values({ phone: '5565977776666', name: 'Com número' }).returning();
    const [lidOnly] = await w.ctx.db.insert(contacts).values({ lid: '208888888888888' }).returning();
    const chat = given(
      umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z', contact: { id: 'C9', name: 'Novo', phoneNumber: '5565977776666', lid: '208888888888888' } }),
      [umblerMessage('Z1', '2026-08-01T10:00:00Z')],
    );
    await importChat(run, chat as never, 'closed');
    expect(await w.ctx.db.$count(contacts, eq(contacts.id, lidOnly!.id))).toBe(0);
    expect((await w.ctx.db.select().from(contacts).where(eq(contacts.id, phone!.id)))[0]).toMatchObject({ lid: '208888888888888' });
    expect((await chatOf(chat.id as string))!.contactId).toBe(phone!.id);
  });
});

describe('deleted in Umbler mid-chat (§9.4)', () => {
  it('a 404 after some pages finishes what was written (event, waiting_since, chat.updated) without done_at', async () => {
    const list = Array.from({ length: 260 }, (_, i) => umblerMessage(`P${i}`, new Date(Date.UTC(2026, 9, 20, 10, 0, 0) + i * 1000).toISOString()));
    const chat = given(umblerChat({ waiting: true, waitingSinceUTC: null }), list);
    w.fake.faults.push({ path: /relative-messages/, status: 404, query: ['FromEventUTC', '2026-10-20T10:04:08.999Z'] });

    expect(await importChat(run, chat as never, 'open')).toBe(true);

    const local = (await chatOf(chat.id as string))!;
    expect(local.waitingSince).toEqual(new Date('2026-10-20T10:04:09Z'));
    expect((await eventsOf(local.id)).map((e) => [e.kind, e.data])).toEqual([['umbler_imported', { count: 250 }]]);
    expect(w.ctx.hub.events.filter((e) => e.type === 'chat' && e.chatId === local.id)).toHaveLength(1);
    expect((await localOf(chat.id as string))!.doneAt).toBeNull();
    expect(run.progress.gone).toBe(1);
  });
});

describe('tombstone on resume (§7)', () => {
  it('a chat resumed without done_at (temporary file failure) still keeps out what was deleted here', async () => {
    await importChat(run, given(umblerChat(), []) as never, 'open'); // creates the contact
    const [maria] = await w.ctx.db.select().from(contacts).where(eq(contacts.phone, '5565999998888'));
    await w.ctx.db.insert(deletedChats).values({ contactId: maria!.id, channelId: w.s.channelId, until: new Date('2026-08-01T10:30:00Z'), deletedAt: new Date() });
    w.fake.world.files['f.pdf'] = { body: PDF, mime: 'application/pdf' };
    w.fake.faults.push({ path: /^\/s3\/f\.pdf$/, status: 500, times: 4 });
    const chat = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T12:00:00Z' }), [
      umblerMessage('T1', '2026-08-01T10:00:00Z'),
      umblerMessage('T2', '2026-08-01T11:00:00Z', { messageType: 'File', content: null, file: file('f.pdf') }),
    ]);
    await importChat(run, chat as never, 'closed');
    const mapped = (await localOf(chat.id as string))!;
    expect(mapped.doneAt).toBeNull(); // resumed on the next run
    await importChat(run, chat as never, 'closed');
    expect((await localOf(chat.id as string))!.doneAt).not.toBeNull();
    expect((await rowsOf(mapped.localId)).map((r) => r.mediaName)).toEqual(['f.pdf']);
    expect(await w.ctx.db.$count(messages)).toBe(1);
  });
});

describe('a second run (§9.2)', () => {
  it('a finished closed chat costs no call; an open one is read again from its last message - 1 ms and only adds what is new', async () => {
    const done = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z' }), [umblerMessage('D1', '2026-08-01T10:00:00Z')]);
    await importChat(run, done as never, 'closed');
    expect(await importChat(run, done as never, 'closed')).toBe(false);
    expect(relativeCalls()).toHaveLength(1);

    const open = given(umblerChat({ contact: { id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: null } }), [
      umblerMessage('O1', '2026-10-20T10:00:00Z'),
    ]);
    await importChat(run, open as never, 'open');
    w.fake.world.messages[open.id as string]!.push(umblerMessage('O2', '2026-10-20T10:05:00Z'));
    open.sector = { id: 'SEC1' }; // changed in Umbler meanwhile: a new run never changes an imported chat
    await importChat(run, open as never, 'open');

    const local = (await chatOf(open.id as string))!;
    expect((await rowsOf(local.id)).map((r) => r.body)).toEqual(['texto O1', 'texto O2']);
    expect(local.sectorId).toBe(w.s.sectorA);
    expect(relativeCalls().at(-1)!.query.get('FromEventUTC')).toBe('2026-10-20T09:59:59.999Z');
    expect((await eventsOf(local.id)).filter((e) => e.kind === 'umbler_imported')).toHaveLength(1);
  });

  it('reads 250 at a time, the next page from the last eventAtUTC - 1 ms, dropping ids it has seen', async () => {
    const list = Array.from({ length: 260 }, (_, i) => umblerMessage(`P${i}`, new Date(Date.UTC(2026, 7, 1, 10, 0, 0) + i * 1000).toISOString()));
    const chat = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T12:00:00Z' }), list);
    await importChat(run, chat as never, 'closed');
    expect(relativeCalls().map((r) => [r.query.get('FromEventUTC'), r.query.get('Take')])).toEqual([
      ['2000-01-01T00:00:00.000Z', '250'],
      ['2026-08-01T10:04:08.999Z', '250'],
    ]);
    expect(await w.ctx.db.$count(messages)).toBe(260);
    expect(run.progress.messages.total).toBe(260);
  });
});
