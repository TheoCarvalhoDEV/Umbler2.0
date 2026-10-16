import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ChatEventKind } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { chatEvents } from '../db/schema.js';

// One union for server and web (shared/src/index.ts); callers keep importing it from here.
export type { ChatEventKind };

export async function addEvent(
  db: Db | Tx,
  chatId: string,
  kind: ChatEventKind,
  data: Record<string, unknown>,
  authorId: string | null,
): Promise<void> {
  // clock_timestamp(), not now(): now() is frozen per transaction, so events written in one tx would tie.
  await db.insert(chatEvents).values({ id: randomUUID(), chatId, kind, data, authorId, createdAt: sql`clock_timestamp()` });
}
