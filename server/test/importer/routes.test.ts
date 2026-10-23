import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UmblerImportDto, UmblerImportStatusDto } from '@talk/shared';
import { settings, umblerImports } from '../../src/db/schema.js';
import { emptyProgress } from '../../src/importer/job.js';
import { BAD_MAPPING, BLOCK_READ_TEST, BLOCK_RULES, NO_TOKEN, NOT_FAILED, UMBLER_RUNNING } from '../../src/importer/routes.js';
import { TEST_ORIGIN, loginAs, makeTestApp } from '../helpers.js';
import { importWorld, proposals, testAnalysis, type World } from './world.js';

let w: World;
let app: FastifyInstance;
let admin: Record<string, string>;
let agent: Record<string, string>;
beforeEach(async () => {
  w = await importWorld();
  ({ app } = await makeTestApp(w.ctx));
  admin = (await loginAs(app, 'admin@teste.local')).headers;
  agent = (await loginAs(app, 'ana@teste.local')).headers;
});
afterEach(async () => {
  await app.close();
  expect(w.fake.requests).toEqual([]); // the routes never call Umbler: the worker does
  await w.fake.close();
});

const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url, headers, payload });
const analyzed = async (over: Partial<typeof umblerImports.$inferInsert> = {}) => {
  const [row] = await w.ctx.db
    .insert(umblerImports)
    .values({ state: 'analyzed', analysis: testAnalysis(w), progress: emptyProgress(), ...over })
    .returning();
  return row!;
};
const rulesOn = () =>
  w.ctx.db.insert(settings).values({
    key: 'auto_rules',
    value: { returnToQueue: { enabled: true, minutes: 30 }, closeInactive: { enabled: false, hours: 24, sendClosingMessage: true } },
  });

describe('Importar do Umbler routes (spec 2026-10-21 importar-umbler §10)', () => {
  it('admins only; a POST without Origin is refused', async () => {
    const row = await analyzed();
    for (const [method, url] of [
      ['GET', '/api/umbler-import'], ['POST', '/api/umbler-import/analyze'], ['POST', `/api/umbler-import/${row.id}/start`],
      ['POST', `/api/umbler-import/${row.id}/resume`],
    ] as const) {
      expect((await call(method, url, agent, method === 'POST' ? {} : undefined)).statusCode).toBe(403);
    }
    const { origin: _origin, ...noOrigin } = admin;
    expect((await call('POST', '/api/umbler-import/analyze', noOrigin)).statusCode).toBe(403);
    expect(admin.origin).toBe(TEST_ORIGIN);
  });

  it('GET says whether the token is configured, never any part of it, and returns the newest import', async () => {
    expect((await call('GET', '/api/umbler-import', admin)).json()).toEqual({ tokenConfigured: false, current: null });
    w.ctx.config.umblerToken = 'tok-segredo-123';
    await analyzed({ createdAt: new Date('2026-10-20T10:00:00Z') });
    const newest = await analyzed({ state: 'done', createdAt: new Date('2026-10-21T10:00:00Z') });
    const res = await call('GET', '/api/umbler-import', admin);
    const body = res.json<UmblerImportStatusDto>();
    expect(body.tokenConfigured).toBe(true);
    expect(body.current).toMatchObject({ id: newest.id, state: 'done', blocks: [] });
    expect(res.body).not.toContain('tok-segredo');
    expect(body.current!.progress).not.toHaveProperty('maps');
  });

  it('analyze: 400 without a token; creates the analyzing row; 409 while one is active', async () => {
    expect((await call('POST', '/api/umbler-import/analyze', admin)).json()).toEqual({ error: NO_TOKEN });
    w.ctx.config.umblerToken = 'tok-teste';
    const first = await call('POST', '/api/umbler-import/analyze', admin);
    expect(first.statusCode).toBe(200);
    expect(first.json<UmblerImportDto>()).toMatchObject({ state: 'analyzing', phase: null, analysis: null, startedAt: null });
    const again = await call('POST', '/api/umbler-import/analyze', admin);
    expect([again.statusCode, again.json()]).toEqual([409, { error: UMBLER_RUNNING }]);
  });

  it('start: every Umbler channel, sector and attendant needs a destination here; then it runs from the catalog', async () => {
    const row = await analyzed();
    const mapping = proposals(row.analysis!);
    const bad = await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping: { ...mapping, sectors: { SEC1: w.s.defaultSector } } });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: BAD_MAPPING }]);
    const webToo = { ...mapping, channels: { ...mapping.channels, CH_WEB: w.s.channelId } }; // not WhatsApp: only "Não importar"
    expect((await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping: webToo })).statusCode).toBe(400);

    const ok = await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping });
    expect(ok.json<UmblerImportDto>()).toMatchObject({ state: 'running', phase: 'catalog', error: null });
    const [stored] = await w.ctx.db.select().from(umblerImports).where(eq(umblerImports.id, row.id));
    expect(stored!.mapping).toEqual(mapping);
    expect(stored!.startedAt).not.toBeNull();
    expect((await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping })).statusCode).toBe(409); // not 'analyzed' anymore
  });

  it('start is blocked while the automatic rules are on or the read test marked a chat; 409 while another import is active', async () => {
    const marked = await analyzed({ analysis: testAnalysis(w, { readTest: 'marked' }) });
    const mapping = proposals(marked.analysis!);
    expect((await call('GET', '/api/umbler-import', admin)).json<UmblerImportStatusDto>().current!.blocks).toEqual([BLOCK_READ_TEST]);
    expect((await call('POST', `/api/umbler-import/${marked.id}/start`, admin, { mapping })).json()).toEqual({ error: BLOCK_READ_TEST });

    await w.ctx.db.update(umblerImports).set({ state: 'done' }).where(eq(umblerImports.id, marked.id));
    const row = await analyzed();
    await rulesOn();
    expect((await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping })).json()).toEqual({ error: BLOCK_RULES });
    await w.ctx.db.delete(settings).where(eq(settings.key, 'auto_rules'));

    await analyzed({ state: 'running', phase: 'contacts', startedAt: new Date() });
    const busy = await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping });
    expect([busy.statusCode, busy.json()]).toEqual([409, { error: UMBLER_RUNNING }]);
  });

  it('resume ("Continuar"): only a failed import; same blocks; back to running in the same phase with the same counters', async () => {
    const progress = { ...emptyProgress(), messages: { ...emptyProgress().messages, total: 120 } };
    const row = await analyzed({ state: 'failed', phase: 'closed_chats', error: 'umbler_429', startedAt: new Date(), progress, mapping: proposals(testAnalysis(w)) });
    const analysis = await analyzed({ state: 'failed', error: 'umbler_token' }); // a failed analysis: "Analisar de novo"
    expect((await call('POST', `/api/umbler-import/${analysis.id}/resume`, admin)).json()).toEqual({ error: NOT_FAILED });

    await rulesOn();
    expect((await call('POST', `/api/umbler-import/${row.id}/resume`, admin)).json()).toEqual({ error: BLOCK_RULES });
    await w.ctx.db.delete(settings).where(eq(settings.key, 'auto_rules'));

    const res = await call('POST', `/api/umbler-import/${row.id}/resume`, admin);
    expect(res.json<UmblerImportDto>()).toMatchObject({ state: 'running', phase: 'closed_chats', error: null, progress: { messages: { total: 120 } } });
    expect((await call('POST', `/api/umbler-import/${row.id}/resume`, admin)).json()).toEqual({ error: NOT_FAILED });
  });
});
