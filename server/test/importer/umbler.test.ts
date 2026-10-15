import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import {
  contactFieldValues,
  contactTags,
  contacts,
  customFields,
  quickAnswers,
  sectors,
  tags,
} from '../../src/db/schema.js';
import { importUmbler, type ImportDeps, type ImportReport } from '../../src/importer/umbler.js';
import { convertUmblerVariables } from '../../src/messages/quick-answers.js';
import { makeTestDb, seedBasics } from '../helpers.js';

// ---------- synthetic Umbler fixtures (shapes from docs/umbler/utalk-openapi-v1.json) ----------
const ORG = 'ORG_TESTE_00001';
const ATTACHMENT_URL = 'https://files.example.test/procuracao.pdf';
const PDF = new TextEncoder().encode('%PDF-1.4 anexo sintetico');
const MAX_TAKE = 2; // the fake caps page size so pagination is exercised

const ME = {
  _t: 'HumanOrganizationAgentModel',
  id: 'MEMBER_1',
  organizations: [{ _t: 'OrganizationReferenceForHumanAgentModel', id: ORG, name: 'Escritório Teste', active: true }],
};

const SECTORS = [
  { _t: 'SectorReferenceModel', id: 'SEC1', name: 'Atendimento', default: true, order: 0, groupIds: [] },
  { _t: 'SectorReferenceModel', id: 'SEC2', name: 'Financeiro', default: false, order: 1, groupIds: [] },
  { _t: 'SectorReferenceModel', id: 'SEC3', name: 'Trabalhista', default: false, order: 2, groupIds: [] },
];

const TAGS = [
  { _t: 'TagModel', id: 'TAG1', name: 'Cliente', emoji: '⭐', color: 'Gold', order: 0, groupIds: [] },
  { _t: 'TagModel', id: 'TAG2', name: 'Prospecção', emoji: null, color: 'Blue', order: 1, groupIds: [] },
];

const FIELD_DEFS = [
  { _t: 'CPFCustomFieldDefinitionModel', id: 'CF1', name: 'CPF', description: null },
  { _t: 'DateCustomFieldDefinitionModel', id: 'CF2', name: 'Nascimento', description: null },
  { _t: 'LogicCustomFieldDefinitionModel', id: 'CF3', name: 'Aceitou termos', description: null },
];

const tagRef = (id: string, name: string) => ({ _t: 'SimpleTagReferenceModel', id, name });

const CONTACTS = [
  {
    _t: 'SimpleContactModel',
    id: 'C1',
    name: 'Maria Teste',
    phoneNumber: '+55 65 9999-8888', // 12 digits once stripped: must gain the 9
    lid: null,
    email: 'maria@example.test',
    landline: null,
    address: { addressLine1: 'Rua das Flores, 100', addressLine2: null, city: 'Cuiabá', state: 'MT', zipCode: null, country: null },
    isBlocked: false,
    tags: [tagRef('TAG1', 'Cliente')],
    customFields: [
      { _t: 'ContactCPFCustomFieldModel', id: 'V1', customFieldDefinitionId: 'CF1', value: '000.000.000-00' },
      { _t: 'ContactDateCustomFieldModel', id: 'V2', customFieldDefinitionId: 'CF2', value: '1990-05-17T00:00:00Z' },
      { _t: 'ContactLogicCustomFieldModel', id: 'V3', customFieldDefinitionId: 'CF3', value: true },
    ],
  },
  {
    _t: 'SimpleContactModel',
    id: 'C2',
    name: 'João Teste',
    phoneNumber: '5565988887777',
    isBlocked: true,
    tags: [tagRef('TAG1', 'Cliente'), tagRef('TAG2', 'Prospecção')],
    customFields: [],
  },
  { _t: 'SimpleContactModel', id: 'C3', name: 'Fixo Teste', phoneNumber: '556532221111', isBlocked: false, tags: [], customFields: [] },
  { _t: 'SimpleContactModel', id: 'C4', name: 'Sem Número', phoneNumber: '123', isBlocked: false, tags: [], customFields: [] },
  { _t: 'SimpleContactModel', id: 'C5', name: null, phoneNumber: null, isBlocked: false, tags: [], customFields: [] },
  {
    _t: 'SimpleContactModel',
    id: 'C6',
    name: 'Maria Duplicada',
    phoneNumber: '5565999998888', // same number as C1 in 13-digit form: merges into C1
    isBlocked: false,
    tags: [tagRef('TAG2', 'Prospecção')],
    customFields: [],
  },
];

const QA_VARIABLES = [
  { name: 'nome', defaultValue: 'Contato.PrimeiroNome' },
  { name: 'assinatura', defaultValue: 'Valor fixo qualquer' },
];
const QUICK_ANSWERS = [
  {
    _t: 'QuickAnswerModel',
    id: 'QA1',
    name: 'Boas-vindas',
    content: 'Olá {{1}}, aqui é {{2}}.',
    groupIds: [],
    variables: QA_VARIABLES,
    attachment: null,
  },
  {
    _t: 'QuickAnswerModel',
    id: 'QA2',
    name: 'Procuração',
    content: 'Segue a procuração.',
    groupIds: [],
    variables: [],
    attachment: { fileId: 'F1', fileType: 'File', url: ATTACHMENT_URL, originalName: 'procuracao.pdf', thumbnail: null },
  },
];

// ---------- fake Umbler API ----------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeUmbler(opts: { rateLimitOnce?: string } = {}) {
  const calls: Array<{ url: URL; auth: string | null }> = [];
  let limited = false;
  const page = (url: URL, items: unknown[]) => {
    const skip = Number(url.searchParams.get('Skip') ?? '0');
    const take = Math.min(Number(url.searchParams.get('Take') ?? '50'), MAX_TAKE);
    const slice = items.slice(skip, skip + take);
    return json({ page: { skipped: skip, took: slice.length, maxTake: MAX_TAKE }, items: slice });
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.href === ATTACHMENT_URL) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
    if (url.pathname === opts.rateLimitOnce && !limited) {
      limited = true;
      return json({ error: 'Too Many Requests' }, 429);
    }
    const p = url.pathname;
    if (p === '/api/v1/members/me/') return json(ME);
    if (p === '/api/v1/sectors/') return json(SECTORS);
    if (p === '/api/v1/tags/') return page(url, TAGS);
    if (p === '/api/v1/custom-field-definitions/') return json(FIELD_DEFS);
    if (p === '/api/v1/contacts/') return page(url, CONTACTS);
    if (p === '/api/v1/quick-answers/') return page(url, QUICK_ANSWERS);
    const detail = /^\/api\/v1\/quick-answers\/([^/]+)\/$/.exec(p);
    const qa = detail && QUICK_ANSWERS.find((q) => q.id === detail[1]);
    if (qa) return json(qa);
    return json({ error: 'not found' }, 404);
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

const FIRST_RUN: Omit<ImportReport, 'unmappedVariables'> = {
  dryRun: false,
  organization: 'Escritório Teste',
  sectors: { created: 1, existing: 2 },
  tags: { created: 2, existing: 0 },
  customFields: { created: 2, existing: 0, unsupported: ['Aceitou termos'] },
  contacts: {
    created: 3,
    existing: 1,
    skippedInvalidPhone: [
      { umblerId: 'C4', name: 'Sem Número', phone: '123' },
      { umblerId: 'C5', name: null, phone: null },
    ],
  },
  quickAnswers: { created: 2, existing: 0, attachments: 1, attachmentErrors: [] },
};

describe('importUmbler', () => {
  let db: Db;
  let mediaDir: string;
  let sleeps: number[];

  const deps = (fake: ReturnType<typeof fakeUmbler>, dryRun = false): ImportDeps => ({
    db,
    mediaDir,
    token: 'tok-teste',
    dryRun,
    fetchImpl: fake.fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  const sizes = async () => ({
    sectors: await db.$count(sectors),
    tags: await db.$count(tags),
    customFields: await db.$count(customFields),
    contacts: await db.$count(contacts),
    contactTags: await db.$count(contactTags),
    contactFieldValues: await db.$count(contactFieldValues),
    quickAnswers: await db.$count(quickAnswers),
  });

  const pdfFiles = async () => (await readdir(mediaDir, { recursive: true })).filter((f) => f.endsWith('.pdf'));

  const tagNamesOf = async (contactId: string) =>
    (
      await db
        .select({ name: tags.name })
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(eq(contactTags.contactId, contactId))
    )
      .map((t) => t.name)
      .sort();

  beforeEach(async () => {
    db = await makeTestDb();
    await seedBasics({ db });
    mediaDir = await mkdtemp(join(tmpdir(), 'talk-import-'));
    sleeps = [];
  });

  afterEach(async () => {
    await rm(mediaDir, { recursive: true, force: true });
  });

  it('maps sectors, tags, custom fields and contacts (12→13 digits, landline kept, invalid phones skipped)', async () => {
    const report = await importUmbler(deps(fakeUmbler()));
    expect(report).toMatchObject(FIRST_RUN);

    const sectorRows = await db.select().from(sectors);
    expect(sectorRows.map((s) => s.name).sort()).toEqual(['Atendimento', 'Financeiro', 'Jurídico', 'Trabalhista']);
    expect(sectorRows.filter((s) => s.isDefault).map((s) => s.name)).toEqual(['Atendimento']);

    const tagRows = await db.select().from(tags).orderBy(tags.position);
    expect(tagRows.map(({ name, emoji, color }) => ({ name, emoji, color }))).toEqual([
      { name: 'Cliente', emoji: '⭐', color: '#ca8a04' }, // shared TAG_COLORS (Task 15): Gold
      { name: 'Prospecção', emoji: null, color: '#2563eb' }, // Blue
    ]);

    const fieldRows = await db.select().from(customFields).orderBy(customFields.position);
    expect(fieldRows.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'CPF', kind: 'cpf' },
      { name: 'Nascimento', kind: 'date' },
    ]);

    const contactRows = await db.select().from(contacts).orderBy(contacts.phone);
    expect(contactRows.map((c) => c.phone)).toEqual(['556532221111', '5565988887777', '5565999998888']);

    const maria = contactRows.find((c) => c.phone === '5565999998888')!;
    expect(maria).toMatchObject({ name: 'Maria Teste', email: 'maria@example.test', blocked: false });
    expect(maria.address).toEqual({ addressLine1: 'Rua das Flores, 100', city: 'Cuiabá', state: 'MT' });
    expect(await tagNamesOf(maria.id)).toEqual(['Cliente', 'Prospecção']); // C6 merged into C1

    const values = await db
      .select({ name: customFields.name, value: contactFieldValues.value })
      .from(contactFieldValues)
      .innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
      .where(eq(contactFieldValues.contactId, maria.id))
      .orderBy(customFields.name);
    expect(values).toEqual([
      { name: 'CPF', value: '000.000.000-00' },
      { name: 'Nascimento', value: '1990-05-17' },
    ]);

    const joao = contactRows.find((c) => c.phone === '5565988887777')!;
    expect(joao).toMatchObject({ name: 'João Teste', blocked: true });
    expect(await tagNamesOf(joao.id)).toEqual(['Cliente', 'Prospecção']);
  });

  it('sends the Bearer token and organizationId to the Umbler API only, and paginates', async () => {
    const fake = fakeUmbler();
    await importUmbler(deps(fake));

    const api = fake.calls.filter((c) => c.url.hostname === 'app-utalk.umbler.com');
    expect(api.length).toBeGreaterThan(0);
    for (const c of api) expect(c.auth).toBe('Bearer tok-teste');
    for (const c of api.filter((c) => c.url.pathname !== '/api/v1/members/me/')) {
      expect(c.url.searchParams.get('organizationId')).toBe(ORG);
    }

    const contactCalls = api.filter((c) => c.url.pathname === '/api/v1/contacts/');
    expect(contactCalls.map((c) => c.url.searchParams.get('Skip'))).toEqual(['0', '2', '4', '6']);
    expect(contactCalls[0].url.searchParams.getAll('includeCustomFields')).toEqual(['CF1', 'CF2', 'CF3']);

    const downloads = fake.calls.filter((c) => c.url.href === ATTACHMENT_URL);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].auth).toBeNull(); // the Umbler token never leaves app-utalk.umbler.com
  });

  it('converts quick-answer variables, reports the unmapped ones and saves the attachment', async () => {
    const report = await importUmbler(deps(fakeUmbler()));
    const expected = convertUmblerVariables(QUICK_ANSWERS[0].content, QA_VARIABLES);

    const [welcome] = await db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Boas-vindas'));
    expect(welcome.body).toBe(expected.body);
    expect(welcome.body).toContain('{{contato.primeiro_nome}}');
    expect(welcome.body).not.toMatch(/\{\{\d+\}\}/);
    expect(welcome).toMatchObject({ visibility: 'all', ownerId: null, attachmentPath: null });

    expect(expected.unmapped).toHaveLength(1);
    expect(report.unmappedVariables).toEqual([{ quickAnswer: 'Boas-vindas', variables: expected.unmapped }]);

    const [proxy] = await db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Procuração'));
    expect(proxy.body).toBe('Segue a procuração.');
    expect(proxy.attachmentPath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
    expect(await readFile(join(mediaDir, proxy.attachmentPath!))).toEqual(Buffer.from(PDF));
  });

  it('is idempotent: a second run creates nothing and downloads nothing', async () => {
    await importUmbler(deps(fakeUmbler()));
    const before = await sizes();

    const fake = fakeUmbler();
    const second = await importUmbler(deps(fake));

    expect(second).toMatchObject({
      sectors: { created: 0, existing: 3 },
      tags: { created: 0, existing: 2 },
      customFields: { created: 0, existing: 2 },
      contacts: { created: 0, existing: 4 },
      quickAnswers: { created: 0, existing: 2, attachments: 0 },
      unmappedVariables: [],
    });
    expect(await sizes()).toEqual(before);
    expect(before).toMatchObject({ contacts: 3, tags: 2, customFields: 2, quickAnswers: 2, contactTags: 4, contactFieldValues: 2 });
    expect(fake.calls.filter((c) => c.url.href === ATTACHMENT_URL)).toHaveLength(0);
    expect(await pdfFiles()).toHaveLength(1);
  });

  it('fills only the empty fields of contacts that already exist', async () => {
    await db.insert(contacts).values([
      { phone: '5565999998888', name: null }, // e.g. created by a webhook before the import
      { phone: '5565988887777', name: 'Nome Editado' },
    ]);

    const report = await importUmbler(deps(fakeUmbler()));
    expect(report.contacts).toMatchObject({ created: 1, existing: 3 });

    const [maria] = await db.select().from(contacts).where(eq(contacts.phone, '5565999998888'));
    expect(maria).toMatchObject({ name: 'Maria Teste', email: 'maria@example.test' });
    const [joao] = await db.select().from(contacts).where(eq(contacts.phone, '5565988887777'));
    expect(joao).toMatchObject({ name: 'Nome Editado', blocked: false });
    expect(await tagNamesOf(joao.id)).toEqual(['Cliente', 'Prospecção']);
  });

  it('dry-run reports the same counts and writes nothing', async () => {
    const fake = fakeUmbler();
    const report = await importUmbler(deps(fake, true));

    expect(report).toMatchObject({ ...FIRST_RUN, dryRun: true });
    expect(report.unmappedVariables).toHaveLength(1);
    expect(await sizes()).toEqual({
      sectors: 3,
      tags: 0,
      customFields: 0,
      contacts: 0,
      contactTags: 0,
      contactFieldValues: 0,
      quickAnswers: 0,
    });
    expect(fake.calls.filter((c) => c.url.href === ATTACHMENT_URL)).toHaveLength(0);
    expect(await readdir(mediaDir)).toEqual([]);
  });

  it('waits and retries when Umbler answers 429', async () => {
    const fake = fakeUmbler({ rateLimitOnce: '/api/v1/sectors/' });
    const report = await importUmbler(deps(fake));

    expect(report.sectors.created).toBe(1);
    expect(sleeps).toContain(5000);
    expect(fake.calls.filter((c) => c.url.pathname === '/api/v1/sectors/')).toHaveLength(2);
  });
});
