import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appointments, chats, contacts, messages, scheduledMessages, umblerMap } from '../../src/db/schema.js';
import { importChat } from '../../src/importer/chats.js';
import { importCatalog, type ImportRun } from '../../src/importer/umbler.js';
import { insertAppointment } from '../automation/seed.js';
import { PDF, umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { insertChat, newContact } from '../inbox/fixtures.js';
import { importWorld, runFor, type World } from './world.js';

let w: World;
let run: ImportRun;
let maria: string;
let historyChat: string;
const T = Date.UTC(2026, 7, 1, 10, 0, 0);
const at = (s: number) => new Date(T + s * 1000);
const iso = (s: number) => at(s).toISOString();

beforeEach(async () => {
  w = await importWorld();
  run = await runFor(w);
  await importCatalog(run);
  maria = await newContact(w.ctx, { phone: '5565999998888', name: 'Maria' });
  historyChat = await insertChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.defaultSector, contactId: maria, state: 'closed', history: true });
});
afterEach(async () => {
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

/** A row the WhatsApp history copy stored (spec 2026-10-16): it has a WhatsApp id. */
async function ours(chatId: string, s: number, values: Partial<typeof messages.$inferInsert>): Promise<string> {
  const [m] = await w.ctx.db
    .insert(messages)
    .values({ chatId, channelId: w.s.channelId, direction: 'in', kind: 'text', status: 'read', sentAt: at(s), createdAt: at(s), ...values })
    .returning({ id: messages.id });
  return m!.id;
}
async function importClosed(list: Array<Record<string, unknown>>): Promise<string> {
  const chat = umblerChat({ open: false, createdAtUTC: iso(0), closedAtUTC: iso(600) });
  w.fake.world.messages[chat.id as string] = list;
  await importChat(run, chat as never, 'closed');
  const [m] = await w.ctx.db.select().from(umblerMap).where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, chat.id as string)));
  return m!.localId;
}
const row = async (id: string) => (await w.ctx.db.select().from(messages).where(eq(messages.id, id)))[0];
const chatRow = async (id: string) => (await w.ctx.db.select().from(chats).where(eq(chats.id, id)))[0];

describe('matching with the WhatsApp history (spec 2026-10-21 importar-umbler §8)', () => {
  it('the same message is not inserted again: our row moves to the imported chat with its id, WhatsApp id and status, and gains the author', async () => {
    const h1 = await ours(historyChat, 3, { body: 'Bom dia', externalId: 'wa1' });
    const h2 = await ours(historyChat, 62, { direction: 'out', body: 'Segue o boleto', externalId: 'wa2', status: 'delivered' });
    const h3 = await ours(historyChat, 71, { body: 'Ok', externalId: 'wa3' }); // 11 s from U4: not the same
    const h4 = await ours(historyChat, 300, { body: 'Outra coisa', externalId: 'wa4' }); // no twin in Umbler

    const imported = await importClosed([
      umblerMessage('U1', iso(0), { content: 'Bom dia' }),
      umblerMessage('U2', iso(60), { source: 'Member', sentByOrganizationMember: { id: 'M_ANA' }, prefix: 'Financeiro - Ana', content: 'Segue o boleto' }),
      umblerMessage('U3', iso(61), { isPrivate: true, source: 'Member', content: 'Segue o boleto' }), // a note never matches
      umblerMessage('U4', iso(60), { content: 'Ok' }),
    ]);

    const rows = await w.ctx.db.select().from(messages).where(eq(messages.chatId, imported)).orderBy(asc(messages.sentAt));
    expect(rows.map((m) => [m.id === h1 || m.id === h2 ? 'ours' : 'new', m.kind, m.body, m.externalId])).toEqual([
      ['ours', 'text', 'Bom dia', 'wa1'],
      ['new', 'text', 'Ok', null],
      ['new', 'note', 'Segue o boleto', null],
      ['ours', 'text', 'Segue o boleto', 'wa2'], // our row keeps its own time (62 s)
    ]);
    expect(await row(h2)).toMatchObject({ authorId: w.s.agentA.id, status: 'delivered', sentAt: at(62) });
    expect(await row(h3)).toMatchObject({ chatId: historyChat });
    expect(await row(h4)).toMatchObject({ chatId: historyChat });
    // the history chat it came from now spans what it has left
    expect(await chatRow(historyChat)).toMatchObject({ createdAt: at(71), closedAt: at(300), lastMessageAt: at(300), lastMessagePreview: 'Outra coisa' });
    expect(run.progress.messages).toMatchObject({ total: 4, matched: 2, maxMatchDiffMs: 3000 });
    const mapped = await w.ctx.db.select().from(umblerMap).where(eq(umblerMap.kind, 'message'));
    expect(Object.fromEntries(mapped.filter((m) => m.umblerId === 'U1' || m.umblerId === 'U2').map((m) => [m.umblerId, m.localId]))).toEqual({ U1: h1, U2: h2 });
  });

  it('a history chat left without messages is deleted (chat.removed); its appointment and scheduled message move to the imported chat', async () => {
    await ours(historyChat, 0, { body: 'Bom dia', externalId: 'wa1' });
    const { reminderId } = await insertAppointment(w.ctx, { chatId: historyChat, authorId: w.s.agentA.id, startsAt: new Date('2026-12-01T13:00:00Z') });
    await w.ctx.db.insert(scheduledMessages).values([
      { chatId: historyChat, authorId: w.s.agentA.id, body: 'Lembrete', signature: false, sendAt: new Date('2026-12-01T12:00:00Z'), reminderId },
      { chatId: historyChat, authorId: w.s.agentA.id, body: 'Agendada', signature: false, sendAt: new Date('2026-11-30T13:00:00Z') },
    ]);

    const imported = await importClosed([umblerMessage('U1', iso(1), { content: 'Bom dia' })]);

    expect(await chatRow(historyChat)).toBeUndefined();
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat.removed', chatId: historyChat });
    // spec 2026-10-21 compromissos §3.8: as in the LID merge (absorb), they follow the messages instead of cascading away
    expect((await w.ctx.db.select().from(appointments)).map((a) => a.chatId)).toEqual([imported]);
    expect((await w.ctx.db.select().from(scheduledMessages).orderBy(asc(scheduledMessages.body))).map((r) => [r.body, r.chatId, r.reminderId, r.status])).toEqual([
      ['Agendada', imported, null, 'pending'],
      ['Lembrete', imported, reminderId, 'pending'],
    ]);
  });

  it("a match whose file had expired on WhatsApp gets Umbler's file; a location gets the §7.7 text", async () => {
    w.fake.world.files['foto.jpg'] = { body: PDF, mime: 'image/jpeg' };
    const photo = await ours(historyChat, 0, { kind: 'image', body: null, externalId: 'wa1', mediaMime: 'image/jpeg', mediaStatus: 'expired' });
    const place = await ours(historyChat, 5, { kind: 'unsupported', body: null, externalId: 'wa2' });
    await ours(historyChat, 900, { body: 'fica no histórico', externalId: 'wa3' });

    await importClosed([
      umblerMessage('U1', iso(0), {
        messageType: 'Image', content: null,
        file: { url: w.fake.fileUrl('foto.jpg'), contentType: 'image/jpeg', originalName: 'foto.jpg', originalSizeBytes: PDF.length, failDownload: false },
      }),
      umblerMessage('U2', iso(4), { messageType: 'Location', location: { latitude: '-15.6', longitude: '-56.1', name: 'Fórum', address: null } }),
    ]);

    const p = (await row(photo))!;
    expect(p).toMatchObject({ mediaStatus: null, mediaMime: 'image/jpeg', externalId: 'wa1' });
    expect(await readFile(join(w.ctx.config.mediaDir, p.mediaPath!))).toEqual(PDF);
    expect(await row(place)).toMatchObject({ kind: 'text', body: 'Localização: Fórum https://maps.google.com/?q=-15.6,-56.1', externalId: 'wa2' });
    expect(run.progress.files).toMatchObject({ saved: 1, expired: 0 });
  });

  it("never matches another contact's row", async () => {
    const other = await newContact(w.ctx);
    const otherChat = await insertChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.defaultSector, contactId: other, state: 'closed', history: true });
    const theirs = await ours(otherChat, 0, { body: 'Bom dia', externalId: 'wa9' });
    await importClosed([umblerMessage('U1', iso(0), { content: 'Bom dia' })]);
    expect(await row(theirs)).toMatchObject({ chatId: otherChat });
    expect(await w.ctx.db.$count(contacts)).toBe(2);
    expect(run.progress.messages.matched).toBe(0);
  });
});
