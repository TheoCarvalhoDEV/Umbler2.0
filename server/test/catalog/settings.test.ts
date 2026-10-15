import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getBotRunningBehavior } from '../../src/catalog/settings.js';
import { settings } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agent: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agent = (await loginAs(app, seed.agentA.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function put(headers: Record<string, string>, payload: object) {
  return app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
}

it('saves the closing message and triage menu (admin only) and validates the menu', async () => {
  const body = {
    closingMessage: 'Atendimento finalizado. Obrigado!',
    triageMenu: {
      enabled: true,
      welcomeText: 'Olá! Escolha uma opção:',
      invalidText: 'Não entendi.',
      options: [
        { key: '1', label: 'Financeiro', sectorId: seed.sectorA },
        { key: '2', label: 'Processos', sectorId: seed.sectorB },
      ],
    },
  };
  const withOptions = (options: object[], enabled = true) => ({ ...body, triageMenu: { ...body.triageMenu, enabled, options } });

  expect((await put(agent, body)).statusCode).toBe(403);
  expect((await put(admin, withOptions([{ key: '1', label: 'X', sectorId: crypto.randomUUID() }]))).statusCode).toBe(400);
  expect((await put(admin, withOptions([]))).statusCode).toBe(400);
  expect(
    (
      await put(
        admin,
        withOptions([
          { key: '1', label: 'A', sectorId: seed.sectorA },
          { key: '1', label: 'B', sectorId: seed.sectorB },
        ]),
      )
    ).statusCode,
  ).toBe(400);
  expect((await put(admin, withOptions([], false))).statusCode).toBe(200); // a disabled menu may be empty

  const saved = await put(admin, body);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ ...body, botRunningBehavior: 'ask' }); // omitted → default

  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(got.statusCode).toBe(200);
  expect(got.json()).toEqual({ ...body, botRunningBehavior: 'ask' });

  // Stored as spec §4 snake_case, which triage/getTriageMenu reads.
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, 'triage_menu'));
  expect(row.value).toEqual({
    enabled: true,
    welcome_text: 'Olá! Escolha uma opção:',
    invalid_text: 'Não entendi.',
    options: [
      { key: '1', label: 'Financeiro', sector_id: seed.sectorA },
      { key: '2', label: 'Processos', sector_id: seed.sectorB },
    ],
  });
  const [closing] = await ctx.db.select().from(settings).where(eq(settings.key, 'closing_message'));
  expect(closing.value).toBe('Atendimento finalizado. Obrigado!');
});

it('stores bot_running_behavior, defaults to ask and rejects unknown values', async () => {
  const base = { closingMessage: '', triageMenu: { enabled: false, welcomeText: '', invalidText: '', options: [] } };

  const fresh = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(fresh.json().botRunningBehavior).toBe('ask'); // key missing
  expect(await getBotRunningBehavior(ctx.db)).toBe('ask');

  expect((await put(admin, { ...base, botRunningBehavior: 'sempre' })).statusCode).toBe(400);
  expect((await put(agent, { ...base, botRunningBehavior: 'stop' })).statusCode).toBe(403);

  const saved = await put(admin, { ...base, botRunningBehavior: 'stop' });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().botRunningBehavior).toBe('stop');
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, 'bot_running_behavior'));
  expect(row.value).toBe('stop');
  expect(await getBotRunningBehavior(ctx.db)).toBe('stop');

  await put(admin, { ...base, botRunningBehavior: 'keep' });
  expect(await getBotRunningBehavior(ctx.db)).toBe('keep');

  // A value that is not one of the three (hand-edited DB, older build) reads as the default.
  await ctx.db.update(settings).set({ value: 'talvez' }).where(eq(settings.key, 'bot_running_behavior'));
  expect(await getBotRunningBehavior(ctx.db)).toBe('ask');
  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(got.json().botRunningBehavior).toBe('ask');
});
