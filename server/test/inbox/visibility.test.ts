import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats, users } from '../../src/db/schema.js';
import { canSee, loadAuthUser, visibleChatsWhere, type AuthUser, type ChatVisibilityFields } from '../../src/inbox/visibility.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat } from './fixtures.js';

const admin: AuthUser = { id: 'adm', name: 'Admin', email: 'a@x.com', role: 'admin', signature: null, sectorIds: [] };
const agent: AuthUser = { id: 'u1', name: 'Ana', email: 'u1@x.com', role: 'agent', signature: null, sectorIds: ['A'] };

const cases: Array<[string, AuthUser, ChatVisibilityFields, boolean]> = [
  ['admin sees a private chat owned by someone else', admin, { sectorId: 'B', ownerId: 'u2', private: true }, true],
  ['sector member sees an unowned chat of the sector', agent, { sectorId: 'A', ownerId: null, private: false }, true],
  ['sector member sees a colleague-owned chat of the sector', agent, { sectorId: 'A', ownerId: 'u2', private: false }, true],
  ['owner sees own chat outside his sectors', agent, { sectorId: 'B', ownerId: 'u1', private: false }, true],
  ['owner sees own private chat', agent, { sectorId: 'B', ownerId: 'u1', private: true }, true],
  ['agent does not see an unowned chat of another sector', agent, { sectorId: 'B', ownerId: null, private: false }, false],
  ['agent does not see a chat of another sector owned by someone else', agent, { sectorId: 'B', ownerId: 'u2', private: false }, false],
  ['sector member does not see a colleague private chat', agent, { sectorId: 'A', ownerId: 'u2', private: true }, false],
];

describe('canSee', () => {
  it.each(cases)('%s', (_name, user, chat, expected) => {
    expect(canSee(user, chat)).toBe(expected);
  });
});

describe('visibleChatsWhere / loadAuthUser (PGlite)', () => {
  let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    ctx = await makeTestCtx();
    s = await seedBasics(ctx);
  });

  it('selects exactly the chats canSee allows, for every kind of user', async () => {
    for (const sectorId of [s.sectorA, s.sectorB, s.defaultSector]) {
      for (const ownerId of [null, s.agentA.id, s.agentB.id]) {
        for (const isPrivate of [false, true]) {
          await insertChat(ctx, { channelId: s.channelId, sectorId, ownerId, private: isPrivate });
        }
      }
    }
    const all = await ctx.db.select().from(chats);
    expect(all).toHaveLength(18);

    const noSectors: AuthUser = { ...s.agentA, sectorIds: [] };
    for (const user of [s.admin, s.agentA, s.agentB, noSectors]) {
      const viaSql = (await ctx.db.select({ id: chats.id }).from(chats).where(visibleChatsWhere(user)))
        .map((r) => r.id)
        .sort();
      const viaCanSee = all
        .filter((c) => canSee(user, c))
        .map((c) => c.id)
        .sort();
      expect(viaSql).toEqual(viaCanSee);
    }
    // sanity on the fixture: 18 for admin; agentA = 2 colleague/unowned in sector A + 6 owned
    expect(all.filter((c) => canSee(s.admin, c))).toHaveLength(18);
    expect(all.filter((c) => canSee(s.agentA, c))).toHaveLength(8);
    expect(all.filter((c) => canSee(noSectors, c))).toHaveLength(6);
  });

  it('loadAuthUser returns sectors, and null for inactive or unknown users', async () => {
    const a = await loadAuthUser(ctx.db, s.agentA.id);
    expect(a).toMatchObject({ id: s.agentA.id, role: 'agent', sectorIds: [s.sectorA] });
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, s.agentB.id));
    expect(await loadAuthUser(ctx.db, s.agentB.id)).toBeNull();
    expect(await loadAuthUser(ctx.db, randomUUID())).toBeNull();
  });
});
