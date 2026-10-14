import { fileURLToPath } from 'node:url';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// server/drizzle — same relative path from src/db (tsx) and dist/db (compiled).
export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createPgDb(url: string): Db {
  return drizzlePg(postgres(url), { schema });
}

// PGlite is a devDependency: imported lazily so the production image never loads it.
// ponytail: one fresh in-memory PGlite per call (~1s); clone a migrated template if suites get slow.
export async function createTestDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}
