import { and, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, messages, tags, umblerMap } from '../../src/db/schema.js';
import { mergeLidPairs } from '../../src/history/merge.js';
import { importChat } from '../../src/importer/chats.js';
import { importCatalog, importContactsPhase, importNotesPhase, type ImportRun } from '../../src/importer/umbler.js';
import { umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { insertChat } from '../inbox/fixtures.js';
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

const contactBy = async (where: ReturnType<typeof eq>) => (await w.ctx.db.select().from(contacts).where(where))[0];
const tagNames = async (contactId: string) =>
  (await w.ctx.db.select({ name: tags.name }).from(contactTags).innerJoin(tags, eq(tags.id, contactTags.tagId)).where(eq(contactTags.contactId, contactId)))
    .map((t) => t.name)
    .sort();

describe('contacts phase (spec 2026-10-21 importar-umbler §7.4)', () => {
  it('phone first, then LID; fills only what is empty; a LID-only contact comes; no phone nor LID stays out', async () => {
    await w.ctx.db.insert(contacts).values({ phone: '5565988887777', name: 'Nome Editado' }); // João, edited here

    await importContactsPhase(run);

    const maria = (await contactBy(eq(contacts.phone, '5565999998888')))!; // '+55 65 9999-8888' gains the 9
    expect(maria).toMatchObject({ name: 'Maria Teste', email: 'maria@example.test', blocked: false, lid: null });
    expect(maria.address).toEqual({ addressLine1: 'Rua das Flores, 100', city: 'Cuiabá', state: 'MT' });
    expect(await tagNames(maria.id)).toEqual(['Cliente']);
    const values = await w.ctx.db
      .select({ name: customFields.name, value: contactFieldValues.value })
      .from(contactFieldValues)
      .innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
      .where(eq(contactFieldValues.contactId, maria.id))
      .orderBy(customFields.name);
    expect(values).toEqual([{ name: 'CPF', value: '000.000.000-00' }, { name: 'Nascimento', value: '1990-05-17' }]);

    const joao = (await contactBy(eq(contacts.phone, '5565988887777')))!;
    expect(joao).toMatchObject({ name: 'Nome Editado', blocked: false, lid: '201234567890123' }); // blocked only on a new contact
    expect(await tagNames(joao.id)).toEqual(['Cliente', 'Prospecção']);

    expect(await contactBy(eq(contacts.lid, '209999999999999'))).toMatchObject({ name: 'Só LID', phone: null });
    expect(run.progress.contacts).toEqual({ created: 1, completed: 1, lidOnly: 1, skipped: 1 });
    expect((await w.ctx.db.select().from(umblerMap)).map((r) => `${r.kind}:${r.umblerId}`).sort()).toEqual(['contact:C1', 'contact:C2', 'contact:C3', 'contactSkipped:C4']);
    expect(run.progress.done).toBe(4);
  });

  it('joins a LID-only contact the WhatsApp history created into the phone contact before any chat (mergeLidPairs)', async () => {
    const [phoneOnly] = await w.ctx.db.insert(contacts).values({ phone: '5565988887777', name: 'João' }).returning();
    const [lidOnly] = await w.ctx.db.insert(contacts).values({ lid: '201234567890123', name: null }).returning();
    const historyChat = await insertChat(w.ctx, {
      channelId: w.s.channelId, sectorId: w.s.defaultSector, contactId: lidOnly!.id, state: 'closed', history: true,
    });

    await importContactsPhase(run);

    expect(await contactBy(eq(contacts.id, lidOnly!.id))).toBeUndefined();
    expect(await contactBy(eq(contacts.id, phoneOnly!.id))).toMatchObject({ lid: '201234567890123' });
    expect((await w.ctx.db.select().from(chats).where(eq(chats.id, historyChat)))[0]!.contactId).toBe(phoneOnly!.id);
  });

  it('an Umbler LID-only contact merged mid-import (mergeLidPairs) keeps its chats and notes importing: umbler_map follows', async () => {
    await importContactsPhase(run);
    const lidOnly = (await contactBy(eq(contacts.lid, '209999999999999')))!;
    const c3 = { _t: 'ContactReferenceModel', id: 'C3', name: 'Só LID', phoneNumber: null, lid: '209999999999999@lid', contactType: 'DirectMessage' };
    const open = umblerChat({ contact: c3 });
    w.fake.world.chats.push(open);
    w.fake.world.messages[open.id as string] = [umblerMessage('L1', '2026-10-20T10:00:00Z')];
    await importChat(run, open as never, 'open');
    // the phone contact with its own open chat on the channel: the merge absorbs the imported open chat into it
    const [phone] = await w.ctx.db.insert(contacts).values({ phone: '5565977776666', name: 'Com número' }).returning();
    const twin = await insertChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.defaultSector, contactId: phone!.id, state: 'open' });

    await mergeLidPairs(w.ctx, [{ lid: '209999999999999', phone: '5565977776666' }]);

    expect(await contactBy(eq(contacts.id, lidOnly.id))).toBeUndefined();
    w.fake.world.messages[open.id as string]!.push(umblerMessage('L2', '2026-10-20T10:05:00Z'));
    await importChat(run, open as never, 'open'); // a second run: goes on in the twin
    expect((await w.ctx.db.select().from(messages).where(eq(messages.chatId, twin))).map((m) => m.body).sort()).toEqual(['texto L1', 'texto L2']);
    const closed = umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z', contact: c3 });
    w.fake.world.chats.push(closed);
    w.fake.world.messages[closed.id as string] = [umblerMessage('L3', '2026-08-01T10:00:00Z')];
    expect(await importChat(run, closed as never, 'closed')).toBe(true);
    const [map] = await w.ctx.db.select().from(umblerMap).where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, closed.id as string)));
    expect((await w.ctx.db.select().from(chats).where(eq(chats.id, map!.localId)))[0]!.contactId).toBe(phone!.id);
    w.fake.world.notes.C3 = [{ _t: 'NoteModel', id: 'N9', content: 'Nota', pinned: false, createdBy: null, createdAtUTC: '2026-08-01T10:00:00Z' }];
    await importNotesPhase(run);
    expect(await w.ctx.db.$count(contactNotes, eq(contactNotes.contactId, phone!.id))).toBe(1);
    expect(run.progress.chats.skippedDeleted).toBe(0);
  });

  it('merges every phone + LID pair of the list, mapped ones too: a crash before the merge or a second run still joins them', async () => {
    const [phoneOnly] = await w.ctx.db.insert(contacts).values({ phone: '5565988887777', name: 'João' }).returning();
    const [lidOnly] = await w.ctx.db.insert(contacts).values({ lid: '201234567890123', name: null }).returning();
    await w.ctx.db.insert(umblerMap).values({ kind: 'contact', umblerId: 'C2', localId: phoneOnly!.id }); // its batch committed, then the crash

    await importContactsPhase(run);

    expect(await contactBy(eq(contacts.id, lidOnly!.id))).toBeUndefined();
    expect(await contactBy(eq(contacts.id, phoneOnly!.id))).toMatchObject({ lid: '201234567890123' });
  });

  it('asks each contact for its fields when the list ignores includeCustomFields (§4.1); a second run calls nothing per contact', async () => {
    w.fake.world.omitCustomFields = true;
    w.fake.world.contactFields.C1 = [{ _t: 'ContactCPFCustomFieldModel', customFieldDefinitionId: 'CF1', value: '111.111.111-11' }];

    await importContactsPhase(run);
    expect(w.fake.calls(/\/custom-fields\/$/).map((r) => r.path)).toEqual([
      '/api/v1/contacts/C1/custom-fields/',
      '/api/v1/contacts/C2/custom-fields/',
      '/api/v1/contacts/C3/custom-fields/',
    ]);
    const maria = (await contactBy(eq(contacts.phone, '5565999998888')))!;
    expect((await w.ctx.db.select().from(contactFieldValues).where(eq(contactFieldValues.contactId, maria.id))).map((v) => v.value)).toEqual([
      '111.111.111-11',
    ]);

    const before = w.fake.requests.length;
    const counted = { ...run.progress.contacts };
    await importContactsPhase(run);
    // the list again (two pages: the second is empty); the skipped C4 has its marker: no fields call, no recount
    expect(w.fake.requests.slice(before).map((r) => r.path)).toEqual(['/api/v1/contacts/', '/api/v1/contacts/']);
    expect(run.progress.contacts).toEqual(counted);
    expect(counted.skipped).toBe(1);
  });
});

describe('notes phase (spec §7.5)', () => {
  it('copies the notes with author, pinned and date; a 404 is skipped and counted; done_at means no second call', async () => {
    w.fake.world.notes.C1 = [
      { _t: 'NoteModel', id: 'N1', content: 'Cliente pediu retorno', pinned: true, createdBy: 'M_ANA', createdAtUTC: '2026-08-01T10:00:00Z' },
      { _t: 'NoteModel', id: 'N2', content: 'Nota da IA', pinned: false, createdBy: 'M_IA', createdAtUTC: '2026-08-02T10:00:00Z' },
    ];
    w.fake.world.notes.C3 = []; // C2 has none: the fake answers 404 (deleted in Umbler)
    await importContactsPhase(run);
    run.progress.done = 0; // as importUmbler does between phases (Task 10)

    await importNotesPhase(run);

    const maria = (await contactBy(eq(contacts.phone, '5565999998888')))!;
    const notes = await w.ctx.db.select().from(contactNotes).where(eq(contactNotes.contactId, maria.id)).orderBy(contactNotes.createdAt);
    expect(notes.map(({ body, pinned, authorId, createdAt }) => ({ body, pinned, authorId, createdAt }))).toEqual([
      { body: 'Cliente pediu retorno', pinned: true, authorId: w.s.agentA.id, createdAt: new Date('2026-08-01T10:00:00Z') },
      { body: 'Nota da IA', pinned: false, authorId: null, createdAt: new Date('2026-08-02T10:00:00Z') },
    ]);
    expect(run.progress).toMatchObject({ notes: 2, gone: 1, done: 3, total: 3 });
    expect(await w.ctx.db.$count(umblerMap, and(eq(umblerMap.kind, 'contact'), isNotNull(umblerMap.doneAt)))).toBe(3);

    const before = w.fake.calls(/\/notes\/$/).length;
    await importNotesPhase(run);
    expect(w.fake.calls(/\/notes\/$/)).toHaveLength(before);
    expect(await w.ctx.db.$count(contactNotes)).toBe(2);
  });
});
