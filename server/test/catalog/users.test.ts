import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { users } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics, TEST_ORIGIN } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agent: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agent = (await loginAs(app, seed.agentA.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function call(method: Method, url: string, headers: Record<string, string>, payload?: object) {
  return app.inject({ method, url, headers, payload });
}

function login(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { email, password } });
}

it('lets any user list users but only admins change them', async () => {
  const list = await call('GET', '/api/users', agent);
  expect(list.statusCode).toBe(200);
  expect(list.json().map((u: { id: string }) => u.id)).toContain(seed.agentB.id);
  expect(list.json()[0]).not.toHaveProperty('passwordHash');

  const attempts: Array<[Method, string, object?]> = [
    ['POST', '/api/users', { name: 'X', email: 'x@example.com', password: 'senha-forte-1' }],
    ['PATCH', `/api/users/${seed.agentB.id}`, { name: 'X' }],
    ['DELETE', `/api/users/${seed.agentB.id}`],
  ];
  for (const [method, url, payload] of attempts) {
    expect((await call(method, url, agent, payload)).statusCode, `${method} ${url}`).toBe(403);
  }
});

it('creates a user who can log in, with sectors', async () => {
  const res = await call('POST', '/api/users', admin, {
    name: 'Carlos Pereira',
    email: ' Carlos@Example.com ',
    password: 'nova-senha-123',
    sectorIds: [seed.sectorA],
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    name: 'Carlos Pereira',
    email: 'carlos@example.com',
    role: 'agent',
    signature: null,
    active: true,
    sectorIds: [seed.sectorA],
  });
  expect(res.json()).not.toHaveProperty('passwordHash');
  expect((await login('carlos@example.com', 'nova-senha-123')).statusCode).toBe(200);

  const dup = await call('POST', '/api/users', admin, { name: 'Outro', email: 'carlos@example.com', password: 'outra-senha-1' });
  expect(dup.statusCode).toBe(409);
  const badSector = await call('POST', '/api/users', admin, {
    name: 'Outro',
    email: 'outro@example.com',
    password: 'outra-senha-1',
    sectorIds: [crypto.randomUUID()],
  });
  expect(badSector.statusCode).toBe(400);
  expect((await call('POST', '/api/users', admin, { name: 'Curta', email: 'c@example.com', password: '123' })).statusCode).toBe(400);
});

it('updates sectors and signature and drops live sockets on visibility changes', async () => {
  const spy = vi.spyOn(ctx.hub, 'disconnectUser');
  const res = await call('PATCH', `/api/users/${seed.agentA.id}`, admin, { sectorIds: [seed.sectorB], signature: 'Dra. Ana' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ sectorIds: [seed.sectorB], signature: 'Dra. Ana' });
  expect(spy).toHaveBeenCalledWith(seed.agentA.id);
  // Sessions survive a sector change.
  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(200);
});

it('does not drop sockets when role and sectors are sent but unchanged; does on a real role change', async () => {
  const spy = vi.spyOn(ctx.hub, 'disconnectUser');
  const cur = (await call('GET', '/api/users', admin)).json().find((u: { id: string }) => u.id === seed.agentA.id);
  const same = await call('PATCH', `/api/users/${seed.agentA.id}`, admin, { role: cur.role, sectorIds: cur.sectorIds, name: 'Novo Nome' });
  expect(same.statusCode).toBe(200);
  expect(spy).not.toHaveBeenCalled();
  expect((await call('PATCH', `/api/users/${seed.agentA.id}`, admin, { role: 'admin' })).statusCode).toBe(200);
  expect(spy).toHaveBeenCalledWith(seed.agentA.id);
});

it('deactivating a user kills their sessions and live sockets', async () => {
  const spy = vi.spyOn(ctx.hub, 'disconnectUser');
  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(200);

  const res = await call('DELETE', `/api/users/${seed.agentA.id}`, admin);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ id: seed.agentA.id, active: false });

  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(401);
  expect(spy).toHaveBeenCalledWith(seed.agentA.id);
  expect((await login(seed.agentA.email, 'senha-teste-123')).statusCode).not.toBe(200);
});

it('resetting a password kills the sessions and the new password works', async () => {
  const spy = vi.spyOn(ctx.hub, 'disconnectUser');
  const res = await call('PATCH', `/api/users/${seed.agentA.id}`, admin, { password: 'outra-senha-456' });
  expect(res.statusCode).toBe(200);
  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(401);
  expect(spy).toHaveBeenCalledWith(seed.agentA.id);
  expect((await login(seed.agentA.email, 'outra-senha-456')).statusCode).toBe(200);
});

it('an admin cannot deactivate or demote themselves', async () => {
  expect((await call('DELETE', `/api/users/${seed.admin.id}`, admin)).statusCode).toBe(400);
  expect((await call('PATCH', `/api/users/${seed.admin.id}`, admin, { role: 'agent' })).statusCode).toBe(400);
  expect((await call('PATCH', `/api/users/${crypto.randomUUID()}`, admin, { name: 'X' })).statusCode).toBe(404);
});

it('resets seeAllSectors whenever the role changes', async () => {
  const other = await call('POST', '/api/users', admin, { name: 'Outro Adm', email: 'adm2@example.com', password: 'senha-teste-123', role: 'admin' });
  const uid = other.json().id as string;
  await ctx.db.update(users).set({ seeAllSectors: true }).where(eq(users.id, uid));
  await call('PATCH', `/api/users/${uid}`, admin, { role: 'agent' });
  await call('PATCH', `/api/users/${uid}`, admin, { role: 'admin' });
  const [row] = await ctx.db.select().from(users).where(eq(users.id, uid));
  expect(row.seeAllSectors).toBe(false);
});

it('keeps seeAllSectors when the PATCH repeats the current role', async () => {
  const other = await call('POST', '/api/users', admin, { name: 'Outro Adm', email: 'adm2@example.com', password: 'senha-teste-123', role: 'admin' });
  const uid = other.json().id as string;
  await ctx.db.update(users).set({ seeAllSectors: true }).where(eq(users.id, uid));
  expect((await call('PATCH', `/api/users/${uid}`, admin, { role: 'admin', name: 'Outro Adm 2' })).statusCode).toBe(200);
  const [row] = await ctx.db.select().from(users).where(eq(users.id, uid));
  expect(row.seeAllSectors).toBe(true);
});
