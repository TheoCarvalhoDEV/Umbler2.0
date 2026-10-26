import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APPOINTMENT_REMINDERS, DEFAULT_AUTO_RULES, DEFAULT_RETURNING_CONTACT } from '@talk/shared';
import { getAppointmentReminders, getAutoRules, getBotRunningBehavior, getReturningContact } from '../../src/catalog/settings.js';
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
  expect(saved.json()).toEqual({ ...body, botRunningBehavior: 'ask', returningContact: DEFAULT_RETURNING_CONTACT }); // omitted → default

  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(got.statusCode).toBe(200);
  expect(got.json()).toEqual({ ...body, botRunningBehavior: 'ask', returningContact: DEFAULT_RETURNING_CONTACT });

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

it('auto rules: both off by default, admin only, saved apart from the other settings and validated (spec 2026-10-20 agendamentos §4)', async () => {
  const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/settings/auto-rules', headers });
  const putRules = (headers: Record<string, string>, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/settings/auto-rules', headers, payload });
  const rules = { returnToQueue: { enabled: true, minutes: 45 }, closeInactive: { enabled: true, hours: 48, sendClosingMessage: false } };

  expect((await get(admin)).json()).toEqual(DEFAULT_AUTO_RULES);
  expect((await get(agent)).statusCode).toBe(403);
  expect((await putRules(agent, rules)).statusCode).toBe(403);
  expect((await putRules({ cookie: admin.cookie! }, rules)).statusCode).toBe(403); // no Origin

  const saved = await putRules(admin, rules);
  expect([saved.statusCode, saved.json()]).toEqual([200, rules]);
  expect(await getAutoRules(ctx.db)).toEqual(rules);

  // the whole-settings PUT does not touch them
  expect((await put(admin, { closingMessage: 'Tchau', triageMenu: { enabled: false, welcomeText: '', invalidText: '', options: [] } })).statusCode).toBe(200);
  expect(await getAutoRules(ctx.db)).toEqual(rules);

  for (const bad of [
    { ...rules, returnToQueue: { enabled: true, minutes: 4 } },
    { ...rules, returnToQueue: { enabled: true, minutes: 1441 } },
    { ...rules, closeInactive: { enabled: true, hours: 0, sendClosingMessage: true } },
    { ...rules, closeInactive: { enabled: true, hours: 721, sendClosingMessage: true } },
    { ...rules, closeInactive: { enabled: true, hours: 1.5, sendClosingMessage: true } },
    { returnToQueue: rules.returnToQueue },
  ]) {
    expect((await putRules(admin, bad)).statusCode).toBe(400);
  }
  expect(await getAutoRules(ctx.db)).toEqual(rules);

  // a broken stored value reads as the defaults (both off)
  await ctx.db.update(settings).set({ value: { returnToQueue: 'sim' } }).where(eq(settings.key, 'auto_rules'));
  expect(await getAutoRules(ctx.db)).toEqual(DEFAULT_AUTO_RULES);
});

it('appointment reminders: the defaults for everyone, saved by an admin only, validated (spec 2026-10-21 compromissos §4)', async () => {
  const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/settings/appointment-reminders', headers });
  const putReminders = (headers: Record<string, string>, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/settings/appointment-reminders', headers, payload });
  const mine = { reminders: [{ amount: 3, unit: 'days', text: 'Olá, {nome}! {titulo} em {data}.' }] };

  expect((await get(agent)).json()).toEqual(DEFAULT_APPOINTMENT_REMINDERS); // the form of every agent starts with them
  expect((await putReminders(agent, mine)).statusCode).toBe(403);
  expect((await putReminders({ cookie: admin.cookie! }, mine)).statusCode).toBe(403); // no Origin

  const saved = await putReminders(admin, { reminders: [{ ...mine.reminders[0], text: '  Olá, {nome}! {titulo} em {data}.  ' }] });
  expect([saved.statusCode, saved.json()]).toEqual([200, mine]);
  expect((await get(agent)).json()).toEqual(mine);

  const unknown = await putReminders(admin, { reminders: [{ amount: 1, unit: 'hours', text: 'Olá, {Nome}!' }] });
  expect([unknown.statusCode, unknown.json().error]).toEqual([400, 'Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}']);
  const sameTime = await putReminders(admin, { reminders: [{ amount: 2, unit: 'days', text: 'a' }, { amount: 48, unit: 'hours', text: 'b' }] });
  expect([sameTime.statusCode, sameTime.json().error]).toEqual([400, 'Dois lembretes cairiam no mesmo horário']);
  for (const bad of [
    { reminders: [] },
    { reminders: Array.from({ length: 6 }, (_, i) => ({ amount: i + 1, unit: 'hours', text: 'a' })) },
    { reminders: [{ amount: 0, unit: 'days', text: 'a' }] },
    { reminders: [{ amount: 31, unit: 'days', text: 'a' }] },
    { reminders: [{ amount: 49, unit: 'hours', text: 'a' }] },
    { reminders: [{ amount: 1.5, unit: 'hours', text: 'a' }] },
    { reminders: [{ amount: 1, unit: 'hours', text: '  ' }] },
    {},
  ]) {
    expect((await putReminders(admin, bad)).statusCode).toBe(400);
  }
  expect(await getAppointmentReminders(ctx.db)).toEqual(mine);

  // a broken stored value reads as the defaults
  await ctx.db.update(settings).set({ value: { reminders: 'sim' } }).where(eq(settings.key, 'appointment_reminders'));
  expect(await getAppointmentReminders(ctx.db)).toEqual(DEFAULT_APPOINTMENT_REMINDERS);
});

it('"Cliente que volta": on for 90 days by default, saved with PUT /api/settings and validated', async () => {
  const base = { closingMessage: '', triageMenu: { enabled: false, welcomeText: '', invalidText: '', options: [] } };
  expect(await getReturningContact(ctx.db)).toEqual({ enabled: true, days: 90 });

  expect((await put(admin, { ...base, returningContact: { enabled: true, days: 0 } })).statusCode).toBe(400);
  expect((await put(admin, { ...base, returningContact: { enabled: true, days: 366 } })).statusCode).toBe(400);
  expect((await put(agent, { ...base, returningContact: { enabled: false, days: 30 } })).statusCode).toBe(403);

  const saved = await put(admin, { ...base, returningContact: { enabled: false, days: 30 } });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().returningContact).toEqual({ enabled: false, days: 30 });
  expect(await getReturningContact(ctx.db)).toEqual({ enabled: false, days: 30 });

  await ctx.db.update(settings).set({ value: { enabled: 'sim' } }).where(eq(settings.key, 'returning_contact'));
  expect(await getReturningContact(ctx.db)).toEqual(DEFAULT_RETURNING_CONTACT); // invalid stored value reads as the default
});
