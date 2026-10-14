import { createTestDb, type Db, type Tx } from '../src/db/client.js';
import { channels, sectors, userSectors, users } from '../src/db/schema.js';

// Task 2 provides the DB part only. Later tasks extend this file (never rename):
//   Task 4 adds makeTestCtx() (fake gateway), Task 6 adds TEST_PASSWORD/TEST_ORIGIN, real
//   password hashes in seedBasics, makeTestApp() and loginAs(); Task 8 swaps in createRecordingHub().

export const makeTestDb = createTestDb;

// Same shape as AuthUser (inbox/visibility.ts, Task 7) — structurally assignable.
export interface SeededUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
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
  const [defaultSector, sectorA, sectorB] = await db
    .insert(sectors)
    .values([
      { name: 'Atendimento', position: 0, isDefault: true },
      { name: 'Financeiro', position: 1 },
      { name: 'Jurídico', position: 2 },
    ])
    .returning({ id: sectors.id });

  // ponytail: 'not-set' hash until Task 6 seeds real argon2 hashes of TEST_PASSWORD.
  const [admin, agentA, agentB] = await db
    .insert(users)
    .values([
      { name: 'Admin Teste', email: 'admin@teste.local', passwordHash: 'not-set', role: 'admin' },
      { name: 'Ana Financeiro', email: 'ana@teste.local', passwordHash: 'not-set', role: 'agent' },
      { name: 'Bruno Jurídico', email: 'bruno@teste.local', passwordHash: 'not-set', role: 'agent' },
    ])
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role, signature: users.signature });

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
    admin: { ...admin, sectorIds: [] },
    agentA: { ...agentA, sectorIds: [sectorA.id] },
    agentB: { ...agentB, sectorIds: [sectorB.id] },
    sectorA: sectorA.id,
    sectorB: sectorB.id,
    defaultSector: defaultSector.id,
    channelId: channel.id,
    instance,
  };
}
