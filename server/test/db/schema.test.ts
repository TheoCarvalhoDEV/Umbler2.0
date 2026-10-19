import { eq, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { botRuns, botVersions, bots, chats, contacts, messageEdits, messages, sectors } from '../../src/db/schema.js';
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
    expect(tables).toHaveLength(21);
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

describe('bot tables', () => {
  let db: Db;
  let s: Seeded;

  beforeEach(async () => {
    db = await makeTestDb();
    s = await seedBasics({ db });
  });

  async function seedBot(name: string) {
    const [bot] = await db.insert(bots).values({ name }).returning();
    const [version] = await db
      .insert(botVersions)
      .values({ botId: bot.id, number: 1, graph: { nodes: [], edges: [] }, valid: false })
      .returning();
    return { bot, version };
  }

  async function seedChat() {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const [chat] = await db
      .insert(chats)
      .values({ contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    return { chatId: chat.id, contactId: contact.id };
  }

  it('defaults a new bot to paused, unpublished, no channels and no runs', async () => {
    const { bot } = await seedBot('Fluxo');
    expect(bot).toMatchObject({
      description: '', status: 'paused', startChannelIds: [], manualStart: false, manualTitle: '',
      manualUnlisted: false, publishedVersionId: null, runCount: 0,
    });
  });

  it('rejects a duplicate bot name and a duplicate version number per bot', async () => {
    const { bot } = await seedBot('Fluxo');
    expect(await pgCode(db.insert(bots).values({ name: 'Fluxo' }))).toBe(UNIQUE_VIOLATION);

    const v = { botId: bot.id, graph: { nodes: [], edges: [] }, valid: true };
    expect(await pgCode(db.insert(botVersions).values({ ...v, number: 1 }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(botVersions).values({ ...v, number: 2 }))).toBeNull();

    const other = await seedBot('Outro');
    expect(other.version.number).toBe(1); // numbers are per bot
  });

  it('allows one non-terminal root run per (chat, bot), any number of terminal runs and call_flow children', async () => {
    const { bot, version } = await seedBot('Fluxo');
    const { chatId, contactId } = await seedChat();
    const base = { botId: bot.id, versionId: version.id, chatId, contactId, currentNodeId: 'inicio' };

    const [first] = await db.insert(botRuns).values({ ...base, state: 'waiting_reply' }).returning();
    expect(first).toMatchObject({ depth: 0, retries: 0, vars: {}, steps: [], waitingSince: null, parentRunId: null });

    for (const state of ['running', 'waiting_reply', 'waiting_timer', 'waiting_flow'] as const) {
      expect(await pgCode(db.insert(botRuns).values({ ...base, state }))).toBe(UNIQUE_VIOLATION);
    }
    for (const state of ['finished', 'stopped', 'failed'] as const) {
      expect(await pgCode(db.insert(botRuns).values({ ...base, state }))).toBeNull();
    }
    // a call_flow child of the same bot (depth 1) is not limited by the index
    expect(await pgCode(db.insert(botRuns).values({ ...base, depth: 1, parentRunId: first.id }))).toBeNull();

    const other = await seedBot('Outro');
    expect(await pgCode(db.insert(botRuns).values({ ...base, botId: other.bot.id, versionId: other.version.id }))).toBeNull();

    // once the first run is terminal, the bot may start again on the chat
    await db.update(botRuns).set({ state: 'finished', finishedAt: new Date() }).where(eq(botRuns.id, first.id));
    expect(await pgCode(db.insert(botRuns).values({ ...base, state: 'running' }))).toBeNull();
  });

  it('deleting a published bot removes its versions and runs and keeps its messages without the run', async () => {
    const { bot, version } = await seedBot('Fluxo');
    await db.update(bots).set({ publishedVersionId: version.id }).where(eq(bots.id, bot.id));
    const { chatId, contactId } = await seedChat();
    const [run] = await db
      .insert(botRuns)
      .values({ botId: bot.id, versionId: version.id, chatId, contactId, currentNodeId: 'inicio' })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ chatId, channelId: s.channelId, direction: 'out', kind: 'text', body: 'Olá!', status: 'sent', botRunId: run.id, sentAt: new Date() })
      .returning();

    await db.delete(bots).where(eq(bots.id, bot.id));

    expect(await db.select().from(botVersions)).toEqual([]);
    expect(await db.select().from(botRuns)).toEqual([]);
    const [kept] = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(kept.botRunId).toBeNull();
  });
});

describe('message action columns', () => {
  let db: Db;
  let s: Seeded;

  beforeEach(async () => {
    db = await makeTestDb();
    s = await seedBasics({ db });
  });

  async function seedMessage() {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const [chat] = await db
      .insert(chats)
      .values({ contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    const [m] = await db
      .insert(messages)
      .values({ chatId: chat.id, channelId: s.channelId, direction: 'out', kind: 'text', body: 'oi', sentAt: new Date() })
      .returning();
    return m;
  }

  it('defaults a message to no office reaction, not deleted, not edited, not forwarded', async () => {
    expect(await seedMessage()).toMatchObject({
      officeReaction: null, deletedAt: null, deletedBy: null, deletedSource: null, editedAt: null, forwardedFromId: null,
      mediaSha256: null,
    });
  });

  it('drops the edit history with its message and only unlinks a forwarded copy', async () => {
    const original = await seedMessage();
    const [copy] = await db
      .insert(messages)
      .values({
        chatId: original.chatId, channelId: s.channelId, direction: 'out', kind: 'text', body: 'oi', sentAt: new Date(),
        forwardedFromId: original.id,
      })
      .returning();
    const [edit] = await db.insert(messageEdits).values({ messageId: original.id, previousBody: 'antes', source: 'contact' }).returning();
    expect(edit).toMatchObject({ editedBy: null, newTextUnavailable: false });
    expect(edit.editedAt).toBeInstanceOf(Date);

    await db.delete(messages).where(eq(messages.id, original.id));

    expect(await db.select().from(messageEdits)).toEqual([]);
    const [after] = await db.select().from(messages).where(eq(messages.id, copy.id));
    expect(after.forwardedFromId).toBeNull();
  });
});
