import { and, desc, eq, gte } from 'drizzle-orm';
import { getReturningContact } from '../catalog/settings.js';
import type { Tx } from '../db/client.js';
import { chats, users } from '../db/schema.js';

/**
 * Ajustes → Conversas "Cliente que volta": where a contact's new chat goes when their last chat (not one imported from the
 * phone history) was closed within the window: that chat's sector, and its attendant while still active. null = the usual
 * flow (default sector, chatbot or triage), also when nobody routed the last chat (default sector, no attendant).
 */
export async function returningDestination(
  tx: Tx,
  contactId: string,
  defaultSectorId: string,
  now: Date,
): Promise<{ sectorId: string; ownerId: string | null } | null> {
  const rule = await getReturningContact(tx);
  if (!rule.enabled) return null;
  const since = new Date(now.getTime() - rule.days * 86_400_000);
  const [last] = await tx
    .select({ sectorId: chats.sectorId, ownerId: chats.ownerId, ownerActive: users.active })
    .from(chats)
    .leftJoin(users, eq(users.id, chats.ownerId))
    .where(and(eq(chats.contactId, contactId), eq(chats.state, 'closed'), eq(chats.history, false), gte(chats.closedAt, since)))
    .orderBy(desc(chats.closedAt), desc(chats.id))
    .limit(1);
  if (!last || (last.sectorId === defaultSectorId && !last.ownerId)) return null;
  return { sectorId: last.sectorId, ownerId: last.ownerActive ? last.ownerId : null };
}
