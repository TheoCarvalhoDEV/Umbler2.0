import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { chats, users, userSectors } from '../db/schema.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
}

export interface ChatVisibilityFields {
  sectorId: string;
  ownerId: string | null;
  private: boolean;
}

/** §6: admin sees everything; a private chat only its owner; otherwise sector member or owner. */
export function canSee(user: AuthUser, chat: ChatVisibilityFields): boolean {
  if (user.role === 'admin') return true;
  if (chat.ownerId === user.id) return true;
  return !chat.private && user.sectorIds.includes(chat.sectorId);
}

/**
 * Same rule as canSee, as a WHERE over `chats`. undefined for admin (no filter).
 * (private=false AND (sector IN mine OR owner=me)) OR (private=true AND owner=me)
 * simplifies to owner=me OR (private=false AND sector IN mine).
 */
export function visibleChatsWhere(user: AuthUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  const mine = eq(chats.ownerId, user.id);
  if (user.sectorIds.length === 0) return mine;
  return or(mine, and(eq(chats.private, false), inArray(chats.sectorId, user.sectorIds)));
}

export async function loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.active, true)));
  if (!u) return null;
  const rows = await db
    .select({ sectorId: userSectors.sectorId })
    .from(userSectors)
    .where(eq(userSectors.userId, userId));
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    signature: u.signature,
    sectorIds: rows.map((r) => r.sectorId),
  };
}
