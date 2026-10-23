import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/auth/password.js';
import { customFields, quickAnswers, sectors, tags, umblerImports, userSectors, users } from '../../src/db/schema.js';
import { importCatalog } from '../../src/importer/umbler.js';
import { convertUmblerVariables } from '../../src/messages/quick-answers.js';
import { PDF } from '../fakes/umbler-api.js';
import { TEST_PASSWORD, loginAs, makeTestApp } from '../helpers.js';
import { importWorld, proposals, runFor, testAnalysis, type World } from './world.js';

let w: World;
beforeEach(async () => {
  w = await importWorld();
});
afterEach(async () => {
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

const userByEmail = async (email: string) => (await w.ctx.db.select().from(users).where(eq(users.email, email)))[0];

describe('catalog phase (spec 2026-10-21 importar-umbler §7.1, §7.2)', () => {
  it('matches sectors by name without case, creates tags and fields, and moves to contacts in the same transaction', async () => {
    const run = await runFor(w);
    await importCatalog(run);

    const sectorRows = await w.ctx.db.select().from(sectors);
    expect(sectorRows.map((s) => s.name).sort()).toEqual(['Atendimento', 'Financeiro', 'Jurídico', 'Trabalhista']);
    const trabalhista = sectorRows.find((s) => s.name === 'Trabalhista')!;
    expect(run.progress.sectors).toEqual({ created: 1, existing: 2 });
    expect(run.progress.maps?.sectors).toEqual({ SEC1: w.s.defaultSector, SEC2: w.s.sectorA, SEC3: trabalhista.id });

    const tagRows = await w.ctx.db.select().from(tags).orderBy(tags.position);
    expect(tagRows.map(({ name, emoji, color }) => ({ name, emoji, color }))).toEqual([
      { name: 'Cliente', emoji: '⭐', color: '#ca8a04' },
      { name: 'Prospecção', emoji: null, color: '#2563eb' },
    ]);
    const fieldRows = await w.ctx.db.select().from(customFields).orderBy(customFields.position);
    expect(fieldRows.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'CPF', kind: 'cpf' },
      { name: 'Nascimento', kind: 'date' },
    ]);
    expect(run.progress.customFields).toEqual({ created: 2, existing: 0, unsupported: ['Aceitou termos'] });

    const [row] = await w.ctx.db.select().from(umblerImports).where(eq(umblerImports.id, run.importId));
    expect(row!.phase).toBe('contacts');
    expect(row!.progress?.maps?.tags).toEqual({ TAG1: tagRows[0]!.id, TAG2: tagRows[1]!.id });
  });

  it('attendants: the same e-mail links the user unchanged; "Criar usuário inativo" makes an agent nobody can log in as (§7.2)', async () => {
    const run = await runFor(w);
    await importCatalog(run);

    const carla = (await userByEmail('carla@antigo.test'))!;
    expect(carla).toMatchObject({ name: 'Carla Antiga', role: 'agent', active: false });
    expect(await w.ctx.db.$count(userSectors, eq(userSectors.userId, carla.id))).toBe(0);
    expect(await verifyPassword(carla.passwordHash, TEST_PASSWORD)).toBe(false);
    expect(run.progress.maps?.members).toEqual({ M_ANA: { id: w.s.agentA.id, active: true }, M_CARLA: { id: carla.id, active: false } });
    expect(run.progress.members).toEqual({ linked: 1, createdInactive: 1, none: 0 });
    expect(await userByEmail('ana@teste.local')).toMatchObject({ name: 'Ana Financeiro', role: 'agent', active: true });

    const { app } = await makeTestApp(w.ctx);
    await expect(loginAs(app, 'carla@antigo.test')).rejects.toThrow(/401/); // nobody knows the password
    await app.close();
  });

  it('"Sem atendente" maps nobody and creates nobody', async () => {
    const analysis = testAnalysis(w);
    const run = await runFor(w, { analysis, mapping: { ...proposals(analysis), members: { M_ANA: 'none', M_CARLA: 'none' } } });
    await importCatalog(run);
    expect(run.progress.maps?.members).toEqual({});
    expect(run.progress.members).toEqual({ linked: 0, createdInactive: 0, none: 2 });
    expect(await userByEmail('carla@antigo.test')).toBeUndefined();
  });

  it("quick answers: variables converted, the attachment saved, and an active user's \"Apenas para mim\" stays that user's", async () => {
    const run = await runFor(w);
    await importCatalog(run);

    const [welcome] = await w.ctx.db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Boas-vindas'));
    const converted = convertUmblerVariables('Olá {{1}}, aqui é {{2}}.', [
      { defaultValue: 'Contato.PrimeiroNome' },
      { defaultValue: 'Valor fixo qualquer' },
    ]);
    expect(welcome).toMatchObject({ body: converted.body, visibility: 'all', ownerId: null, attachmentPath: null });
    const [proxy] = await w.ctx.db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Procuração'));
    expect(proxy).toMatchObject({ visibility: 'owner', ownerId: w.s.agentA.id });
    expect(await readFile(join(w.ctx.config.mediaDir, proxy!.attachmentPath!))).toEqual(PDF);
    expect(run.progress.quickAnswers).toEqual({ created: 2, existing: 0, unmappedVariables: ['Boas-vindas'], attachmentErrors: [] });
    expect(w.fake.calls(/^\/s3\//).map((r) => r.auth)).toEqual([null]); // the token never leaves app-utalk
  });

  it('keeps what is already here (any case); a second catalog creates nothing and downloads nothing', async () => {
    await w.ctx.db.insert(tags).values({ name: 'cliente', color: '#000000' });
    await w.ctx.db.insert(quickAnswers).values({ name: 'BOAS-VINDAS', body: 'Olá!' });
    const first = await runFor(w);
    await importCatalog(first);
    expect(first.progress.tags).toEqual({ created: 1, existing: 1 });
    expect(first.progress.quickAnswers).toMatchObject({ created: 1, existing: 1 });

    const second = await runFor(w);
    await importCatalog(second);
    expect(second.progress).toMatchObject({
      sectors: { created: 0, existing: 3 },
      tags: { created: 0, existing: 2 },
      customFields: { created: 0, existing: 2 },
      members: { linked: 2, createdInactive: 0, none: 0 },
      quickAnswers: { created: 0, existing: 2 },
    });
    expect(w.fake.calls(/^\/s3\//)).toHaveLength(1);
    expect(w.fake.calls(/\/quick-answers\/QA\d\/$/).map((r) => r.path)).toEqual(['/api/v1/quick-answers/QA2/']);
  });
});
