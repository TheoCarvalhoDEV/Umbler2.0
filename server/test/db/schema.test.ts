import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { chats, contacts, messages, sectors } from '../../src/db/schema.js';
import { makeTestDb, seedBasics, type Seeded } from '../helpers.js';

// Postgres error code of a rejected query (drizzle wraps driver errors in `cause`), null if it succeeded.
async function pgCode(query: PromiseLike<unknown>): Promise<string | null> {
  try {
    await query;
    return null;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? 'unknown';
  }
}

const UNIQUE_VIOLATION = '23505';

describe('database schema', () => {
  let db: Db;
  let s: Seeded;

  beforeEach(async () => {
    db = await makeTestDb();
    s = await seedBasics({ db });
  });

  it('applies the migration: every schema table and column exists', async () => {
    const tables = Object.values(schema).filter((t) => is(t, PgTable));
    expect(tables).toHaveLength(17);
    // select() lists every column explicitly, so a column missing from the SQL fails here.
    for (const t of tables) await db.select().from(t).limit(1);
  });

  it('allows only one default sector', async () => {
    expect(await pgCode(db.insert(sectors).values({ name: 'Outro', isDefault: true }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(sectors).values({ name: 'Outro', isDefault: false }))).toBeNull();
  });

  it('allows one open chat per contact and channel, plus any number of closed ones', async () => {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const chat = { contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector };

    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'open' }))).toBeNull();
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'open' }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'closed', closedAt: new Date() }))).toBeNull();
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'closed', closedAt: new Date() }))).toBeNull();
  });

  it('rejects a duplicate (channel_id, external_id) but accepts many NULL external ids', async () => {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const [chat] = await db
      .insert(chats)
      .values({ contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    const msg = { chatId: chat.id, channelId: s.channelId, direction: 'in' as const, kind: 'text' as const, body: 'oi', sentAt: new Date() };

    expect(await pgCode(db.insert(messages).values({ ...msg, externalId: 'ABC' }))).toBeNull();
    expect(await pgCode(db.insert(messages).values({ ...msg, externalId: 'ABC' }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(messages).values({ ...msg, kind: 'note', externalId: null }))).toBeNull();
    expect(await pgCode(db.insert(messages).values({ ...msg, kind: 'note', externalId: null }))).toBeNull();
  });
});
