import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { migrationsFolder, type Db } from './client.js';
import type * as schema from './schema.js';

// Production only: `db` must come from createPgDb (tests use createTestDb, which migrates itself).
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db as PostgresJsDatabase<typeof schema>, { migrationsFolder });
}
