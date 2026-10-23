import { eq } from 'drizzle-orm';
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerMappingDto } from '@talk/shared';
import { umblerImports } from '../../src/db/schema.js';
import { emptyProgress, runUmblerJob, type JobDeps, type UmblerImportRow } from '../../src/importer/job.js';
import { createUmblerClient, type ImportRun, type UmblerClient } from '../../src/importer/umbler.js';
import { ORG, startFakeUmbler, type FakeUmbler } from '../fakes/umbler-api.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

// The Umbler import tests' world (spec 2026-10-21 importar-umbler §14): a test app context, the seeded office and the fake
// Umbler API. Every test ends with expect(w.fake.problems()).toEqual([]) and w.fake.close().

export interface World {
  ctx: Awaited<ReturnType<typeof makeTestCtx>>;
  s: Awaited<ReturnType<typeof seedBasics>>;
  fake: FakeUmbler;
  client: UmblerClient;
  sleeps: number[];
  free: { bytes: number };
}

export async function importWorld(): Promise<World> {
  const ctx = await makeTestCtx();
  const s = await seedBasics(ctx);
  const fake = await startFakeUmbler();
  const sleeps: number[] = [];
  const client = createUmblerClient({ token: 'tok-teste', baseUrl: fake.baseUrl, sleep: async (ms) => void sleeps.push(ms) });
  return { ctx, s, fake, client, sleeps, free: { bytes: 100 * 1024 ** 3 } };
}

/** What "Analisar" proposes for the fake's default world (the analysis test checks the real one against it). */
export function testAnalysis(w: World, over: Partial<UmblerAnalysisDto> = {}): UmblerAnalysisDto {
  return {
    organizationId: ORG,
    organization: 'Escritório Teste',
    contacts: { total: 4, existing: 0, withoutAddress: 1 },
    chats: { open: 0, waiting: 0, closed: 0, from: null, to: null },
    channels: [
      {
        id: 'CH_WA', name: 'WhatsApp Umbler', type: 'OrganizationBrokerWhatsappChannelReferenceModel', phone: '5565999990000',
        whatsapp: true, chats: 0, proposal: w.s.channelId,
      },
      { id: 'CH_WEB', name: 'Site', type: 'OrganizationWebsiteWidgetChannelReferenceModel', phone: null, whatsapp: false, chats: 0, proposal: 'none' },
    ],
    sectors: [
      { id: 'SEC1', name: 'Atendimento', proposal: w.s.defaultSector },
      { id: 'SEC2', name: 'FINANCEIRO', proposal: w.s.sectorA },
      { id: 'SEC3', name: 'Trabalhista', proposal: 'create' },
    ],
    members: [
      { id: 'M_ANA', name: 'Ana Umbler', email: 'ANA@teste.local', active: true, chats: 0, proposal: w.s.agentA.id },
      { id: 'M_CARLA', name: 'Carla Antiga', email: 'carla@antigo.test', active: false, chats: 0, proposal: 'create' },
    ],
    tags: { new: 2, existing: 0 },
    customFields: { new: 2, existing: 0, unsupported: ['Aceitou termos'] },
    quickAnswers: { new: 2, existing: 0 },
    readTest: 'not_done',
    warnings: [],
    ...over,
  };
}

export function proposals(a: UmblerAnalysisDto): UmblerMappingDto {
  return {
    channels: Object.fromEntries(a.channels.map((c) => [c.id, c.proposal])),
    sectors: Object.fromEntries(a.sectors.map((s) => [s.id, s.proposal])),
    members: Object.fromEntries(a.members.map((m) => [m.id, m.proposal])),
  };
}

/**
 * An ImportRun as job.ts builds it, over a new umbler_imports row (the tests call the phases directly). The row is
 * 'analyzed', not active, so one test can make several runs (umbler_imports_one_active).
 */
export async function runFor(w: World, opts: { analysis?: UmblerAnalysisDto; mapping?: UmblerMappingDto } = {}): Promise<ImportRun> {
  const analysis = opts.analysis ?? testAnalysis(w);
  const mapping = opts.mapping ?? proposals(analysis);
  const [row] = await w.ctx.db
    .insert(umblerImports)
    .values({ state: 'analyzed', phase: 'catalog', analysis, mapping, startedAt: new Date() })
    .returning();
  return {
    ctx: w.ctx, client: w.client, importId: row!.id, org: ORG, analysis, mapping,
    progress: { ...emptyUmblerCounts(), done: 0, total: 0, chatsRead: 0 },
    signal: new AbortController().signal,
    sleep: async (ms) => void w.sleeps.push(ms),
    freeBytes: async () => w.free.bytes,
  };
}

export const depsOf = (w: World): JobDeps => ({ client: w.client, sleep: async (ms) => void w.sleeps.push(ms), freeBytes: async () => w.free.bytes });

export async function rowOf(w: World, id: string): Promise<UmblerImportRow> {
  return (await w.ctx.db.select().from(umblerImports).where(eq(umblerImports.id, id)))[0]!;
}

/** "Analisar" as the worker runs it: a new 'analyzing' row and one job beat. */
export async function analyze(w: World): Promise<UmblerImportRow> {
  const [row] = await w.ctx.db.insert(umblerImports).values({ state: 'analyzing', progress: emptyProgress() }).returning();
  await runUmblerJob(w.ctx, depsOf(w));
  return rowOf(w, row!.id);
}

/** "Importar" after an analysis, as the start route leaves the row, then one job beat (every phase, unless it stops). */
export async function startImport(w: World, row: UmblerImportRow, deps: JobDeps = depsOf(w)): Promise<UmblerImportRow> {
  await w.ctx.db
    .update(umblerImports)
    .set({ state: 'running', phase: 'catalog', mapping: proposals(row.analysis!), startedAt: new Date() })
    .where(eq(umblerImports.id, row.id));
  await runUmblerJob(w.ctx, deps);
  return rowOf(w, row.id);
}
