import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { contacts } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

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

it('rejects catalog writes from agents with 403', async () => {
  const missing = crypto.randomUUID();
  const attempts: Array<[Method, string, object?]> = [
    ['POST', '/api/sectors', { name: 'X' }],
    ['PATCH', `/api/sectors/${seed.sectorA}`, { name: 'X' }],
    ['DELETE', `/api/sectors/${seed.sectorA}`],
    ['POST', '/api/tags', { name: 'X', color: '#000000' }],
    ['PATCH', `/api/tags/${missing}`, { name: 'X' }],
    ['DELETE', `/api/tags/${missing}`],
    ['POST', '/api/custom-fields', { name: 'X', kind: 'text' }],
    ['PATCH', `/api/custom-fields/${missing}`, { name: 'X' }],
    ['DELETE', `/api/custom-fields/${missing}`],
  ];
  for (const [method, url, payload] of attempts) {
    expect((await call(method, url, agent, payload)).statusCode, `${method} ${url}`).toBe(403);
  }
});

describe('sectors', () => {
  it('making a sector the default unsets the previous one', async () => {
    const res = await call('POST', '/api/sectors', admin, { name: 'Recepção', isDefault: true });
    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(created).toMatchObject({ name: 'Recepção', isDefault: true });

    const defaults = async () =>
      (await call('GET', '/api/sectors', agent))
        .json()
        .filter((s: { isDefault: boolean }) => s.isDefault)
        .map((s: { id: string }) => s.id);
    expect(await defaults()).toEqual([created.id]);

    expect((await call('PATCH', `/api/sectors/${seed.defaultSector}`, admin, { isDefault: true })).statusCode).toBe(200);
    expect(await defaults()).toEqual([seed.defaultSector]);

    expect((await call('PATCH', `/api/sectors/${seed.defaultSector}`, admin, { isDefault: false })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/sectors/${crypto.randomUUID()}`, admin, { isDefault: true })).statusCode).toBe(404);
    expect(await defaults()).toEqual([seed.defaultSector]); // the 404 rolled back the unset

    const renamed = await call('PATCH', `/api/sectors/${seed.sectorA}`, admin, { name: 'Financeiro 2' });
    expect(renamed.json()).toMatchObject({ id: seed.sectorA, name: 'Financeiro 2', isDefault: false });
  });

  it('deletes a sector only when it is not the default and has no chats', async () => {
    const contactId = crypto.randomUUID();
    const now = new Date();
    await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria', phone: '5565999995555', createdAt: now, updatedAt: now });
    await findOrOpenChat(ctx.db, {
      contactId,
      channelId: seed.channelId,
      init: { sectorId: seed.sectorA, ownerId: null, waiting: false, triagePending: false, createdBy: null },
    });

    expect((await call('DELETE', `/api/sectors/${seed.sectorA}`, admin)).statusCode).toBe(409);
    expect((await call('DELETE', `/api/sectors/${seed.defaultSector}`, admin)).statusCode).toBe(409);

    const empty = (await call('POST', '/api/sectors', admin, { name: 'Temporário' })).json();
    expect((await call('DELETE', `/api/sectors/${empty.id}`, admin)).statusCode).toBe(204);
    const ids = (await call('GET', '/api/sectors', admin)).json().map((s: { id: string }) => s.id);
    expect(ids).not.toContain(empty.id);
    expect(ids).toContain(seed.sectorA);
  });
});

describe('tags', () => {
  it('validates name and color, rejects duplicates, updates and deletes', async () => {
    expect((await call('POST', '/api/tags', admin, { name: 'x'.repeat(31), color: '#ff0000' })).statusCode).toBe(400);
    expect((await call('POST', '/api/tags', admin, { name: 'VIP', color: 'red' })).statusCode).toBe(400);

    const res = await call('POST', '/api/tags', admin, { name: 'VIP', emoji: '⭐', color: '#FF0000' });
    expect(res.statusCode).toBe(200);
    const tag = res.json();
    expect(tag).toMatchObject({ name: 'VIP', emoji: '⭐', color: '#ff0000' });
    expect(typeof tag.position).toBe('number');

    expect((await call('POST', '/api/tags', admin, { name: 'VIP', color: '#00ff00' })).statusCode).toBe(409);
    const other = (await call('POST', '/api/tags', admin, { name: 'Novo', color: '#00ff00' })).json();
    expect((await call('PATCH', `/api/tags/${other.id}`, admin, { name: 'VIP' })).statusCode).toBe(409);

    const patched = await call('PATCH', `/api/tags/${tag.id}`, admin, { name: 'VIP Ouro', emoji: null });
    expect(patched.json()).toMatchObject({ id: tag.id, name: 'VIP Ouro', emoji: null, color: '#ff0000' });

    const list = (await call('GET', '/api/tags', agent)).json().map((t: { id: string }) => t.id);
    expect(list).toContain(tag.id);

    expect((await call('DELETE', `/api/tags/${tag.id}`, admin)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/tags/${tag.id}`, admin)).statusCode).toBe(404);
  });
});

describe('custom fields', () => {
  it('creates, lists, renames and deletes fields', async () => {
    const res = await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'cpf' });
    expect(res.statusCode).toBe(200);
    const field = res.json();
    expect(field).toMatchObject({ name: 'CPF', kind: 'cpf' });

    expect((await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'text' })).statusCode).toBe(409);
    expect((await call('POST', '/api/custom-fields', admin, { name: 'E-mail 2', kind: 'email' })).statusCode).toBe(400);

    const renamed = await call('PATCH', `/api/custom-fields/${field.id}`, admin, { name: 'CPF do cliente' });
    expect(renamed.json()).toMatchObject({ id: field.id, name: 'CPF do cliente', kind: 'cpf' });

    const list = (await call('GET', '/api/custom-fields', agent)).json().map((f: { id: string }) => f.id);
    expect(list).toEqual([field.id]);

    expect((await call('DELETE', `/api/custom-fields/${field.id}`, admin)).statusCode).toBe(204);
    expect((await call('GET', '/api/custom-fields', agent)).json()).toEqual([]);
  });
});
