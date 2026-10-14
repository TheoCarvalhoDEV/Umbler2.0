import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession, deleteSession, deleteUserSessions, getSessionUser } from '../../src/auth/sessions.js';
import { sessions, users } from '../../src/db/schema.js';
import { loadAuthUser } from '../../src/inbox/visibility.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

const DAY = 86_400_000;

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
});

describe('loadAuthUser', () => {
  it('loads the user with sector ids', async () => {
    const u = await loadAuthUser(ctx.db, seed.agentA.id);
    expect(u).toMatchObject({ id: seed.agentA.id, email: seed.agentA.email, role: 'agent', sectorIds: [seed.sectorA] });
  });

  it('returns null for an unknown id', async () => {
    expect(await loadAuthUser(ctx.db, randomUUID())).toBeNull();
  });
});

describe('sessions', () => {
  it('stores only the sha256 of the raw token', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    const rows = await ctx.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(token);
    expect(rows[0].id).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('getSessionUser returns the AuthUser for a valid token', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    const u = await getSessionUser(ctx.db, token);
    expect(u).toMatchObject({ id: seed.agentA.id, role: 'agent', sectorIds: [seed.sectorA] });
  });

  it('returns null for an unknown or empty token', async () => {
    expect(await getSessionUser(ctx.db, 'nao-existe')).toBeNull();
    expect(await getSessionUser(ctx.db, '')).toBeNull();
  });

  it('slides the expiry forward on use', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    await ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() + DAY) });
    expect(await getSessionUser(ctx.db, token)).not.toBeNull();
    const [row] = await ctx.db.select().from(sessions);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('returns null for an expired session', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    await ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getSessionUser(ctx.db, token)).toBeNull();
  });

  it('returns null when the user was deactivated', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, seed.agentA.id));
    expect(await getSessionUser(ctx.db, token)).toBeNull();
  });

  it('deleteSession invalidates just that token', async () => {
    const t1 = await createSession(ctx.db, seed.agentA.id);
    const t2 = await createSession(ctx.db, seed.agentA.id);
    await deleteSession(ctx.db, t1);
    expect(await getSessionUser(ctx.db, t1)).toBeNull();
    expect(await getSessionUser(ctx.db, t2)).not.toBeNull();
  });

  it('deleteUserSessions invalidates every session of that user only', async () => {
    const a1 = await createSession(ctx.db, seed.agentA.id);
    const a2 = await createSession(ctx.db, seed.agentA.id);
    const b1 = await createSession(ctx.db, seed.agentB.id);
    await deleteUserSessions(ctx.db, seed.agentA.id);
    expect(await getSessionUser(ctx.db, a1)).toBeNull();
    expect(await getSessionUser(ctx.db, a2)).toBeNull();
    expect(await getSessionUser(ctx.db, b1)).not.toBeNull();
  });
});
