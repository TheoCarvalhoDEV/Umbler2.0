import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats, users } from '../../src/db/schema.js';
import { canSee, loadAuthUser, visibleChatsWhere, type AuthUser, type ChatVisibilityFields } from '../../src/inbox/visibility.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat } from './fixtures.js';

const agent: AuthUser = { id: 'u1', name: 'Ana', email: 'u1@x.com', role: 'agent', signature: null, sectorIds: ['A'], seeAllSectors: false, avatarUrl: null };
const admin: AuthUser = { ...agent, id: 'adm', email: 'a@x.com', role: 'admin' }; // sector A, "ver todos" off
const adminAll: AuthUser = { ...admin, seeAllSectors: true };

const cases: Array<[string, AuthUser, ChatVisibilityFields, boolean]> = [
  ['admin with "ver todos" sees a private chat of another sector', adminAll, { sectorId: 'B', ownerId: 'u2', private: true }, true],
  ['admin with "ver todos" sees an unowned chat of another sector', adminAll, { sectorId: 'B', ownerId: null, private: false }, true],
  ['admin without "ver todos" does not see a chat of another sector', admin, { sectorId: 'B', ownerId: null, private: false }, false],
  ['admin without "ver todos" does not see a colleague private chat of his sector', admin, { sectorId: 'A', ownerId: 'u2', private: true }, false],
  ['admin without "ver todos" sees a chat of his sector', admin, { sectorId: 'A', ownerId: 'u2', private: false }, true],
  ['admin without "ver todos" sees own chat outside his sectors', admin, { sectorId: 'B', ownerId: 'adm', private: true }, true],
  ['agent with seeAllSectors set (not admin) gets no extra visibility', { ...agent, seeAllSectors: true }, { sectorId: 'B', ownerId: null, private: false }, false],
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
    const adminAll: AuthUser = { ...s.admin, seeAllSectors: true };
    const adminInA: AuthUser = { ...s.admin, sectorIds: [s.sectorA] };
    for (const user of [s.admin, adminAll, adminInA, s.agentA, s.agentB, noSectors]) {
      const viaSql = (await ctx.db.select({ id: chats.id }).from(chats).where(visibleChatsWhere(user)))
        .map((r) => r.id)
        .sort();
      const viaCanSee = all
        .filter((c) => canSee(user, c))
        .map((c) => c.id)
        .sort();
      expect(viaSql).toEqual(viaCanSee);
    }
    // sanity on the fixture: 18 for admin with "ver todos", 0 for an admin without sectors or chats;
    // agentA = 2 colleague/unowned in sector A + 6 owned
    expect(all.filter((c) => canSee(adminAll, c))).toHaveLength(18);
    expect(all.filter((c) => canSee(s.admin, c))).toHaveLength(0);
    expect(all.filter((c) => canSee(adminInA, c))).toHaveLength(3);
    expect(all.filter((c) => canSee(s.agentA, c))).toHaveLength(8);
    expect(all.filter((c) => canSee(noSectors, c))).toHaveLength(6);
  });

  it('loadAuthUser returns sectors, and null for inactive or unknown users', async () => {
    const a = await loadAuthUser(ctx.db, s.agentA.id);
    expect(a).toMatchObject({ id: s.agentA.id, role: 'agent', sectorIds: [s.sectorA], seeAllSectors: false });
    await ctx.db.update(users).set({ seeAllSectors: true }).where(eq(users.id, s.admin.id));
    expect(await loadAuthUser(ctx.db, s.admin.id)).toMatchObject({ role: 'admin', seeAllSectors: true });
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, s.agentB.id));
    expect(await loadAuthUser(ctx.db, s.agentB.id)).toBeNull();
    expect(await loadAuthUser(ctx.db, randomUUID())).toBeNull();
  });
});
