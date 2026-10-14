import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { requireAdmin } from '../../src/auth/plugin.js';
import { deleteUserSessions } from '../../src/auth/sessions.js';
import { sessions, users } from '../../src/db/schema.js';
import type { AppCtx } from '../../src/ctx.js';
import { TEST_ORIGIN, TEST_PASSWORD, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

let app: FastifyInstance;
let ctx: AppCtx;
let seed: Awaited<ReturnType<typeof seedBasics>>;

const login = (email: string, password: string, origin: string | null = TEST_ORIGIN) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: origin ? { origin } : {},
    payload: { email, password },
  });

beforeEach(async () => {
  ({ app, ctx } = await makeTestApp());
  seed = await seedBasics(ctx);
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/auth/login', () => {
  it('returns Me and sets an HttpOnly SameSite=Lax sid cookie', async () => {
    const res = await login(seed.agentA.email, TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: seed.agentA.id,
      name: seed.agentA.name,
      email: seed.agentA.email,
      role: 'agent',
      signature: seed.agentA.signature,
      sectorIds: [seed.sectorA],
    });
    const sid = res.cookies.find((c) => c.name === 'sid');
    expect(sid?.value).toBeTruthy();
    expect(sid?.httpOnly).toBe(true);
    expect(sid?.sameSite).toBe('Lax');
    expect(sid?.path).toBe('/');
    expect(Boolean(sid?.secure)).toBe(ctx.config.cookieSecure);
  });

  it('accepts the email in any case and with spaces', async () => {
    const res = await login(`  ${seed.agentA.email.toUpperCase()} `, TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong password with 401 and creates no session', async () => {
    const res = await login(seed.agentA.email, 'errada');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'E-mail ou senha inválidos' });
    expect(await ctx.db.select().from(sessions)).toHaveLength(0);
  });

  it('rejects an unknown email with the same 401', async () => {
    const res = await login('ninguem@example.com', TEST_PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'E-mail ou senha inválidos' });
  });

  it('rejects an inactive user with 403', async () => {
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, seed.agentA.id));
    const res = await login(seed.agentA.email, TEST_PASSWORD);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Usuário desativado' });
  });

  it('rate-limits to 5 attempts per minute per IP+email', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(seed.agentA.email, 'errada')).statusCode).toBe(401);
    }
    const blocked = await login(seed.agentA.email, TEST_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
    // another email from the same IP is a different key
    expect((await login(seed.agentB.email, TEST_PASSWORD)).statusCode).toBe(200);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns Me with a valid cookie (GET needs no Origin)', async () => {
    const { cookie } = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: seed.admin.id, role: 'admin' });
  });

  it('returns 401 after deleteUserSessions (deactivate / password reset)', async () => {
    const { headers } = await loginAs(app, seed.agentB.email);
    await deleteUserSessions(ctx.db, seed.agentB.id);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session so the cookie stops working', async () => {
    const { headers } = await loginAs(app, seed.agentA.email);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(out.statusCode).toBe(204);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, seed.agentA.id))).toHaveLength(0);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(me.statusCode).toBe(401);
  });
});

describe('Origin check (CSRF)', () => {
  it('rejects a POST without Origin with 403', async () => {
    const res = await login(seed.agentA.email, TEST_PASSWORD, null);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Origem não permitida' });
  });

  it('rejects a POST from another origin with 403, even with a valid cookie', async () => {
    const { cookie } = await loginAs(app, seed.agentA.email);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, seed.agentA.id))).toHaveLength(1);
  });
});

describe('session required on /api/*', () => {
  it('gives 401 to an anonymous /api route before the handler, but /api/health stays public', async () => {
    const c = await makeTestCtx();
    const s = await seedBasics(c);
    const a: FastifyInstance = await buildApp(c);
    let ran = false;
    a.get('/api/test-user', async (req) => {
      ran = true;
      return { id: req.user.id };
    });
    await a.ready();
    try {
      expect((await a.inject({ method: 'GET', url: '/api/test-user' })).statusCode).toBe(401);
      expect(ran).toBe(false);
      // Percent-encoded path (Fastify routes on the decoded one) must not dodge auth or CSRF.
      expect((await a.inject({ method: 'GET', url: '/%61pi/test-user' })).statusCode).toBe(401);
      expect((await a.inject({ method: 'POST', url: '/%61pi/test-user' })).statusCode).toBe(403);
      expect((await a.inject({ method: 'GET', url: '/api/%' })).statusCode).toBe(400);
      expect(ran).toBe(false);
      expect((await a.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      const agent = await loginAs(a, s.agentA.email);
      const ok = await a.inject({ method: 'GET', url: '/api/test-user', headers: agent.headers });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ id: s.agentA.id });
    } finally {
      await a.close();
    }
  });
});

describe('requireAdmin', () => {
  it('gives 401 anonymous, 403 agent, 200 admin', async () => {
    const c = await makeTestCtx();
    const s = await seedBasics(c);
    const a: FastifyInstance = await buildApp(c);
    a.get('/api/test-admin', { preHandler: requireAdmin }, async () => ({ ok: true }));
    await a.ready();
    try {
      expect((await a.inject({ method: 'GET', url: '/api/test-admin' })).statusCode).toBe(401);
      const agent = await loginAs(a, s.agentA.email);
      expect((await a.inject({ method: 'GET', url: '/api/test-admin', headers: agent.headers })).statusCode).toBe(403);
      const admin = await loginAs(a, s.admin.email);
      expect((await a.inject({ method: 'GET', url: '/api/test-admin', headers: admin.headers })).statusCode).toBe(200);
    } finally {
      await a.close();
    }
  });
});
