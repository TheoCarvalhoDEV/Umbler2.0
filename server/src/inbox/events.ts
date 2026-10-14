import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../db/client.js';
import { chatEvents } from '../db/schema.js';

export type ChatEventKind = 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed';

export async function addEvent(
  db: Db | Tx,
  chatId: string,
  kind: ChatEventKind,
  data: Record<string, unknown>,
  authorId: string | null,
): Promise<void> {
  await db.insert(chatEvents).values({ id: randomUUID(), chatId, kind, data, authorId, createdAt: new Date() });
}
