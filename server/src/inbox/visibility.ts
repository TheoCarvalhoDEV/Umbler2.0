import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { userSectors, users } from '../db/schema.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
}

export async function loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null> {
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, signature: users.signature })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return null;
  const rows = await db.select({ sectorId: userSectors.sectorId }).from(userSectors).where(eq(userSectors.userId, userId));
  return { ...u, sectorIds: rows.map((r) => r.sectorId) };
}
