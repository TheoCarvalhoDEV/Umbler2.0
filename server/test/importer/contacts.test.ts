import { and, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, tags, umblerMap } from '../../src/db/schema.js';
import { importCatalog, importContactsPhase, importNotesPhase, type ImportRun } from '../../src/importer/umbler.js';
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
