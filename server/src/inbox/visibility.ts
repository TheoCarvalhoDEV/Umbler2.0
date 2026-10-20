import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { UserPreferences } from '@talk/shared';
import { readPreferences } from '../auth/preferences.js';
import type { Db, Tx } from '../db/client.js';
import { chats, users, userSectors } from '../db/schema.js';
import { userAvatarUrl } from '../media/avatar-files.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
  seeAllSectors: boolean; // only meaningful for admins ("Ver todos os setores")
  avatarUrl: string | null;
  preferences?: UserPreferences; // spec 2026-10-19 §6: optional so literals compile; loadAuthUser always fills it
}

export interface ChatVisibilityFields {
  sectorId: string;
  ownerId: string | null;
  private: boolean;
  history?: boolean; // imported from the phone (history spec §8)
}

const seesAll = (user: AuthUser) => user.role === 'admin' && user.seeAllSectors;

/**
 * Sector barrier: an admin with "ver todos" sees everything; anyone else (admins included) sees own chats
 * plus the non-private chats of their sectors. Imported history chats predate the system: every user sees them.
 */
export function canSee(user: AuthUser, chat: ChatVisibilityFields): boolean {
  if (seesAll(user)) return true;
  if (chat.history) return true;
  if (chat.ownerId === user.id) return true;
  return !chat.private && user.sectorIds.includes(chat.sectorId);
}

/**
 * Same rule as canSee, as a WHERE over `chats`. undefined only for an admin with "ver todos" (no filter).
 * history OR owner=me OR (private=false AND sector IN mine).
 */
export function visibleChatsWhere(user: AuthUser): SQL | undefined {
  if (seesAll(user)) return undefined;
  const history = eq(chats.history, true);
  const mine = eq(chats.ownerId, user.id);
  if (user.sectorIds.length === 0) return or(history, mine);
  return or(history, mine, and(eq(chats.private, false), inArray(chats.sectorId, user.sectorIds)));
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
    seeAllSectors: u.seeAllSectors,
    avatarUrl: userAvatarUrl(u),
    preferences: readPreferences(u.preferences),
  };
}
