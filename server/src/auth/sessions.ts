import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { loadAuthUser, type AuthUser } from '../inbox/visibility.js';

const DAY_MS = 86_400_000;

const tokenId = (rawToken: string) => createHash('sha256').update(rawToken).digest('hex');
const expiry = (days: number) => new Date(Date.now() + days * DAY_MS);

/** Returns the raw token (goes only into the cookie); the DB keeps its SHA-256. */
export async function createSession(db: Db | Tx, userId: string, days = 30): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({ id: tokenId(rawToken), userId, expiresAt: expiry(days) });
  return rawToken;
}

export async function getSessionUser(db: Db | Tx, rawToken: string, days = 30): Promise<AuthUser | null> {
  if (!rawToken) return null;
  const id = tokenId(rawToken);
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), eq(users.active, true)));
  if (!row) return null;
  // ponytail: one UPDATE per authenticated request; fine for 3–10 agents, throttle (e.g. only when >1h old) if it ever shows up in profiles.
  await db.update(sessions).set({ expiresAt: expiry(days) }).where(eq(sessions.id, id));
  return loadAuthUser(db, row.userId);
}

export async function deleteSession(db: Db | Tx, rawToken: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenId(rawToken)));
}

export async function deleteUserSessions(db: Db | Tx, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
