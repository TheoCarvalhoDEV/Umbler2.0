import { createTestDb, type Db, type Tx } from '../src/db/client.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { AppCtx } from '../src/ctx.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { createRecordingHub } from '../src/realtime/hub.js';
import { createFakeGateway } from '../src/whatsapp/fake.js';
import { createBotRuntime, createFakeClock, type FakeClock } from '../src/bots/runtime.js';
import { eq } from 'drizzle-orm';
import { channels, sectors, userSectors, users } from '../src/db/schema.js';

// Task 2 provides the DB part only. Later tasks extend this file (never rename):
//   Task 4 adds makeTestCtx() (fake gateway), Task 6 adds TEST_PASSWORD/TEST_ORIGIN, real
//   password hashes in seedBasics, makeTestApp() and loginAs(); Task 8 swaps in createRecordingHub().

export const makeTestDb = createTestDb;

export const TEST_PASSWORD = 'senha-teste-123';
export const TEST_ORIGIN = 'http://localhost:5173';

// Hashed once per test process: argon2 is deliberately slow.
let testHash: Promise<string> | undefined;
export function testPasswordHash(): Promise<string> {
  return (testHash ??= hashPassword(TEST_PASSWORD));
}

// Same shape as AuthUser (inbox/visibility.ts, Task 7) — structurally assignable.
export interface SeededUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
  seeAllSectors: boolean;
  avatarUrl: string | null;
}

export interface Seeded {
  admin: SeededUser;
  agentA: SeededUser;
  agentB: SeededUser;
  sectorA: string;
  sectorB: string;
  defaultSector: string;
  channelId: string;
  instance: string;
}

// Accepts any AppCtx (only `db` is used).
export async function seedBasics(ctx: { db: Db | Tx }): Promise<Seeded> {
  const { db } = ctx;
  const passwordHash = await testPasswordHash();
  const [defaultSector, sectorA, sectorB] = await db
    .insert(sectors)
    .values([
      { name: 'Atendimento', position: 0, isDefault: true },
      { name: 'Financeiro', position: 1 },
      { name: 'Jurídico', position: 2 },
    ])
    .returning({ id: sectors.id });

  const [admin, agentA, agentB] = await db
    .insert(users)
    .values([
      { name: 'Admin Teste', email: 'admin@teste.local', passwordHash, role: 'admin' },
      { name: 'Ana Financeiro', email: 'ana@teste.local', passwordHash, role: 'agent' },
      { name: 'Bruno Jurídico', email: 'bruno@teste.local', passwordHash, role: 'agent' },
    ])
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role, signature: users.signature, seeAllSectors: users.seeAllSectors });

  await db.insert(userSectors).values([
    { userId: agentA.id, sectorId: sectorA.id },
    { userId: agentB.id, sectorId: sectorB.id },
  ]);

  const instance = 'talk-test';
  const [channel] = await db
    .insert(channels)
    .values({ name: 'WhatsApp teste', evolutionInstance: instance, status: 'connected' })
    .returning({ id: channels.id });

  return {
    admin: { ...admin, sectorIds: [], avatarUrl: null },
    agentA: { ...agentA, sectorIds: [sectorA.id], avatarUrl: null },
    agentB: { ...agentB, sectorIds: [sectorB.id], avatarUrl: null },
    sectorA: sectorA.id,
    sectorB: sectorB.id,
    defaultSector: defaultSector.id,
    channelId: channel.id,
    instance,
  };
}

/** Turns on "Ver todos os setores" for an admin, in the DB and on the passed object (tests pass it to services). */
export async function enableSeeAll(ctx: { db: Db | Tx }, user: SeededUser): Promise<SeededUser> {
  await ctx.db.update(users).set({ seeAllSectors: true }).where(eq(users.id, user.id));
  user.seeAllSectors = true;
  return user;
}

// Fresh in-memory DB, fake gateway, recording hub, fake clock and test config per call.
export async function makeTestCtx(): Promise<
  AppCtx & { wa: ReturnType<typeof createFakeGateway>; hub: ReturnType<typeof createRecordingHub>; clock: FakeClock }
> {
  const db = await createTestDb();
  const config: Config = {
    port: 0,
    databaseUrl: 'pglite://memory',
    appOrigin: TEST_ORIGIN,
    cookieSecure: false,
    webhookSecret: 'test-webhook-secret-0123456789abcdef',
    webhookBaseUrl: 'http://app:3000',
    mediaDir: await mkdtemp(join(tmpdir(), 'talk-media-')),
    webDistDir: null,
    evolution: { url: 'http://evolution.test', apiKey: 'test-key' },
    sessionDays: 30,
    umblerToken: null,
  };
  const clock = createFakeClock();
  return { db, wa: createFakeGateway(), hub: createRecordingHub(), config, clock, botRuntime: createBotRuntime({ now: clock.now }) };
}

export async function makeTestApp(ctx?: AppCtx): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const c = ctx ?? (await makeTestCtx());
  const app = await buildApp(c);
  await app.ready();
  return { app, ctx: c };
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<{ cookie: string; headers: Record<string, string> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: TEST_ORIGIN },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`loginAs(${email}) falhou: ${res.statusCode} ${res.body}`);
  const sid = res.cookies.find((c) => c.name === 'sid');
  if (!sid) throw new Error('login não devolveu o cookie sid');
  const cookie = `sid=${sid.value}`;
  return { cookie, headers: { cookie, origin: TEST_ORIGIN } };
}
